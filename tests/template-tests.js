// Proves what JavaScriptResource.mustache does before any port embeds it.
// The template is not executable on its own, so each check renders it with a
// model matching JavaScriptResource.AsDictionary in pipeline-dotnet and then
// either reads the rendered script or evaluates it in a stubbed browser and
// drives it against a fake endpoint.
//
// Three things are covered. The formatting constraints every port's own tests
// enforce, being the closing constructor line, the document.cookie count, no
// mustache braces left in the output and no trailing whitespace. The
// environment with no window at all, which is where the cloud's NiL.JS builder
// evaluates the script. And the behaviour a 51Did depends on, being one
// request body with each key sent once, the record of the inputs that throws
// away a stale answer, the visitor's answer reaching the request, refresh()
// and the failure paths.
//
// Run it with "npm test" from this directory, or with
// "node tests/template-tests.js" from the repository root once "npm install"
// has run here. One line is printed per check and the exit code is non zero
// when any check fails.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Mustache = require('mustache');

const templatePath = path.join(__dirname, '..', 'JavaScriptResource.mustache');
const template = fs.readFileSync(templatePath, 'utf8');

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log('  PASS  ' + name);
    } else {
        failures++;
        console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
    }
}
function section(name) {
    console.log('\n=== ' + name + ' ===');
}

// ---------------------------------------------------------------------------
// The model, matching JavaScriptResource.AsDictionary in pipeline-dotnet.
// ---------------------------------------------------------------------------
function model(overrides) {
    const base = {
        _objName: 'fod',
        _jsonObject: '{"device":{"ismobile":true},"javascriptProperties":[]}',
        _sessionId: 'abc-123',
        _sequence: 1,
        _supportsPromises: true,
        _supportsFetch: true,
        _url: 'https://cloud.example.com/json',
        // WebUtility.UrlEncode is applied to both key and value by
        // GetParameters, so the rendered values are already encoded.
        _parameters: '{"mark":"second","id.usage":"personalized"}',
        _enableCookies: false,
        _updateEnabled: true,
        _hasDelayedProperties: false,
        _userPrompt: false
    };
    return Object.assign(base, overrides || {});
}

function render(overrides) {
    return Mustache.render(template, model(overrides));
}

// ---------------------------------------------------------------------------
// Storage stub. The template reads sessionStorage.length, sessionStorage.key(i)
// and window.sessionStorage[name] directly, so the stub has to behave like the
// real thing rather than only offering getItem and setItem.
// ---------------------------------------------------------------------------
function makeStorage(options) {
    const data = {};
    const opts = options || {};
    const methods = {
        getItem: function (k) {
            if (opts.throwOnRead) { throw new Error('storage blocked'); }
            return Object.prototype.hasOwnProperty.call(data, String(k))
                ? data[String(k)] : null;
        },
        setItem: function (k, v) { data[String(k)] = String(v); },
        removeItem: function (k) { delete data[String(k)]; },
        key: function (i) {
            const keys = Object.keys(data);
            return i >= 0 && i < keys.length ? keys[i] : null;
        },
        clear: function () { Object.keys(data).forEach(k => delete data[k]); }
    };
    const proxy = new Proxy(data, {
        get(t, p) {
            if (p === 'length') { return Object.keys(data).length; }
            if (Object.prototype.hasOwnProperty.call(methods, p)) {
                return methods[p];
            }
            if (typeof p === 'string' &&
                Object.prototype.hasOwnProperty.call(data, p)) {
                return data[p];
            }
            return undefined;
        },
        set(t, p, v) { data[String(p)] = String(v); return true; },
        has(t, p) {
            return p === 'length' ||
                Object.prototype.hasOwnProperty.call(methods, p) ||
                Object.prototype.hasOwnProperty.call(data, p);
        },
        deleteProperty(t, p) { delete data[String(p)]; return true; },
        ownKeys() { return Object.keys(data); },
        getOwnPropertyDescriptor(t, p) {
            if (Object.prototype.hasOwnProperty.call(data, p)) {
                return {
                    value: data[p], writable: true,
                    enumerable: true, configurable: true
                };
            }
            return undefined;
        }
    });
    return { storage: proxy, data: data };
}

// A document with the cookie accessor the template reads and a snippet
// writes. One pair per name and the last write wins, which is how a browser
// behaves for a cookie written with no attributes.
function makeCookieDocument(store) {
    return {
        get cookie() {
            return Object.keys(store).map(function (name) {
                return name + '=' + store[name];
            }).join('; ');
        },
        set cookie(value) {
            const pair = String(value).split(';')[0];
            const at = pair.indexOf('=');
            if (at === -1) { return; }
            store[pair.substring(0, at).trim()] = pair.substring(at + 1);
        }
    };
}

// A minimal window with the event plumbing the block uses.
function makeWindow(extras) {
    const listeners = {};
    const win = {
        addEventListener: function (name, handler) {
            listeners[name] = listeners[name] || [];
            listeners[name].push(handler);
        },
        removeEventListener: function (name, handler) {
            const list = listeners[name] || [];
            const at = list.indexOf(handler);
            if (at > -1) { list.splice(at, 1); }
        }
    };
    Object.assign(win, extras || {});
    win.__fire = function (name, detail) {
        (listeners[name] || []).slice().forEach(h => h({ detail: detail }));
    };
    win.__listenerCount = function (name) {
        return (listeners[name] || []).length;
    };
    return win;
}

// A fake endpoint. Every POST body is captured and the scripted response for
// the current round is returned.
function makeEndpoint(responses) {
    const bodies = [];
    let round = 0;
    function fetchStub(url, options) {
        bodies.push(options.body);
        const body = responses[Math.min(round, responses.length - 1)];
        round++;
        if (body instanceof Error) {
            return Promise.reject(body);
        }
        if (body && body.status && body.status >= 400) {
            return Promise.resolve({ ok: false, status: body.status });
        }
        return Promise.resolve({
            ok: true,
            status: 200,
            text: function () { return Promise.resolve(body); }
        });
    }
    return { fetch: fetchStub, bodies: bodies, count: () => bodies.length };
}

function makeConsole(log) {
    return {
        log: (...a) => log.push(['log', a.join(' ')]),
        warn: (...a) => log.push(['warn', a.join(' ')]),
        error: (...a) => log.push(['error', a.join(' ')])
    };
}

// Build a context and run the script in it. Anything left out of `globals` is
// genuinely not defined in the context, which is what the NiL.JS case needs.
function run(script, globals) {
    const log = [];
    const sandbox = Object.assign({ console: makeConsole(log) }, globals);
    const context = vm.createContext(sandbox);
    let error = null;
    try {
        vm.runInContext(script, context, { filename: 'JavaScriptResource.js' });
    } catch (err) {
        error = err;
    }
    return { context: sandbox, log: log, error: error };
}

const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(times) {
    for (let i = 0; i < (times || 8); i++) { await tick(); }
}

// ---------------------------------------------------------------------------
section('Formatting constraints the other ports\' tests enforce');
// ---------------------------------------------------------------------------
{
    const withBlock = render({ _userPrompt: true });
    const withoutBlock = render({ _userPrompt: false });

    // Rust asserts the script ends with the constructor line.
    const endsRight = s => /var fod = new fiftyoneDegreesManager\(\);\r?\n?$/
        .test(s);
    check('rendered script ends with the constructor line, block on',
        endsRight(withBlock));
    check('rendered script ends with the constructor line, block off',
        endsRight(withoutBlock));

    // Java, Node, Python, PHP and .NET count document.cookie occurrences, so
    // the new code must add none. With cookies off the template renders none
    // at all apart from the rewrite pattern, which is escaped.
    check('no document.cookie in the rendered script with cookies off',
        !withBlock.includes('document.cookie'),
        withBlock.includes('document.cookie') ? 'found one' : '');
    const cookieCount = s => (s.match(/document\.cookie/g) || []).length;
    const cookiesOn = render({ _enableCookies: true, _userPrompt: true });
    check('document.cookie count with cookies on is 1, as on main',
        cookieCount(cookiesOn) === 1, 'count ' + cookieCount(cookiesOn));

    // Rust asserts no mustache braces survive.
    for (const [name, s] of [['block on', withBlock], ['block off', withoutBlock],
    ['cookies on', cookiesOn]]) {
        check('no {{ or }} left in the rendered script, ' + name,
            !s.includes('{' + '{') && !s.includes('}' + '}'),
            'first at ' + Math.max(s.indexOf('{' + '{'), s.indexOf('}' + '}')));
    }

    // No trailing whitespace, in the template and in the output.
    const trailing = s => s.split(/\r?\n/).filter(l => /[ \t]$/.test(l));
    check('no trailing whitespace in the template',
        trailing(template).length === 0,
        JSON.stringify(trailing(template).slice(0, 3)));
    check('no trailing whitespace in the rendered script',
        trailing(withBlock).length === 0,
        JSON.stringify(trailing(withBlock).slice(0, 3)));

    // Every section closed. Count the opening and closing tags per name.
    const opens = {};
    const closes = {};
    const tag = /\{\{([#^\/])([A-Za-z0-9_]+)\}\}/g;
    let m;
    while ((m = tag.exec(template)) !== null) {
        const bucket = m[1] === '/' ? closes : opens;
        bucket[m[2]] = (bucket[m[2]] || 0) + 1;
    }
    const names = Array.from(new Set(Object.keys(opens).concat(Object.keys(closes))));
    for (const name of names) {
        check('section ' + name + ' opens and closes the same number of times',
            (opens[name] || 0) === (closes[name] || 0),
            (opens[name] || 0) + ' open, ' + (closes[name] || 0) + ' close');
    }

    // Nothing after the constructor line in the template itself.
    const lines = template.split(/\r?\n/);
    const last = lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1;
    check('nothing after the constructor line in the template',
        lines[last] === 'var {{_objName}} = new fiftyoneDegreesManager();',
        JSON.stringify(lines[last]));

    // The script must parse.
    for (const [name, s] of [['block on', withBlock], ['block off', withoutBlock],
    ['cookies on', cookiesOn],
    ['no updates', render({ _updateEnabled: false, _userPrompt: true })],
    ['no promises', render({ _supportsPromises: false, _userPrompt: true })],
    ['xhr', render({ _supportsFetch: false, _userPrompt: true })],
    ['delayed', render({ _hasDelayedProperties: true, _userPrompt: true })]]) {
        let ok = true, why = '';
        try { new vm.Script(s); } catch (err) { ok = false; why = err.message; }
        check('the rendered script parses, ' + name, ok, why);
    }
}

// ---------------------------------------------------------------------------
section('The NiL.JS environment, which has no window and no localStorage');
// ---------------------------------------------------------------------------
{
    // Exactly what CloudJavaScriptBuilderElementTests does, being
    // "var sessionStorage = undefined;" and then the script, with no window
    // and no localStorage anywhere in the context.
    for (const userPrompt of [false, true]) {
        const script = 'var sessionStorage = undefined;\n' +
            render({ _userPrompt: userPrompt });
        const result = run(script, {});
        check('evaluates without throwing, sessionStorage declared undefined, ' +
            'block ' + (userPrompt ? 'on' : 'off'),
            result.error === null,
            result.error ? result.error.stack.split('\n')[0] : '');
        if (result.error === null) {
            check('fod.device.ismobile reads back, block ' +
                (userPrompt ? 'on' : 'off'),
                result.context.fod.device.ismobile === true,
                String(result.context.fod && result.context.fod.device));
        }
    }

    // The harder case, being window, localStorage and sessionStorage all
    // genuinely undefined. Run on the promise path and on the path without
    // promises, because an exception thrown inside a promise executor turns
    // into a rejection and would otherwise hide the fault.
    for (const userPrompt of [false, true]) {
      for (const promises of [true, false]) {
        const result = run(
            render({ _userPrompt: userPrompt, _supportsPromises: promises }), {});
        check('evaluates without throwing with nothing defined, block ' +
            (userPrompt ? 'on' : 'off') + ', promises ' + promises,
            result.error === null,
            result.error ? result.error.stack.split(String.fromCharCode(10))[0] : '');
        // With the block on and no platform anywhere the one expected
        // console line is the missing platform warning, which is the only
        // signal a page without a stub gets.
        const allowed = result.log.filter(e =>
            !(e[0] === 'warn' &&
              e[1].startsWith('51Degrees: no preference platform')));
        check('nothing unexpected was logged with nothing defined, block ' +
            (userPrompt ? 'on' : 'off') + ', promises ' + promises,
            allowed.length === 0, JSON.stringify(result.log));
      }
    }

    for (const userPrompt of [false, true]) {
        const result = run(render({ _userPrompt: userPrompt }), {});
        check('evaluates without throwing with window, localStorage and ' +
            'sessionStorage all undefined, block ' + (userPrompt ? 'on' : 'off'),
            result.error === null,
            result.error ? result.error.stack.split('\n')[0] : '');
        if (result.error === null) {
            check('fod.device.ismobile reads back with nothing defined, block ' +
                (userPrompt ? 'on' : 'off'),
                result.context.fod.device.ismobile === true);
        }
    }
}

// ---------------------------------------------------------------------------
section('The cache record');
// ---------------------------------------------------------------------------

// A payload that asks for one snippet, and the snippet itself. With cookies
// off the template rewrites the cookie write into a session storage write.
const SNIPPET = 'var v = "purple"; document.cookie = "51D_testvalue=" + v;';
const firstPayload = JSON.stringify({
    device: { ismobile: true, testvaluejavascript: SNIPPET },
    javascriptProperties: ['device.testvaluejavascript']
});
const secondPayload = JSON.stringify({
    device: { ismobile: true, testvalue: 'purple' },
    javascriptProperties: []
});

// Build a full browser-like environment sharing one storage pair, so that a
// second page view in the same tab sees the first one's entries.
function makeTab() {
    const session = makeStorage();
    const local = makeStorage();
    return { session: session, local: local, cookies: {} };
}

function pageView(tab, options) {
    const opts = options || {};
    const endpoint = opts.endpoint ||
        makeEndpoint(opts.responses || [secondPayload]);
    const log = [];
    const listeners = {};
    const sandbox = {
        console: makeConsole(log),
        sessionStorage: tab.session.storage,
        localStorage: tab.local.storage,
        fetch: endpoint.fetch,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        addEventListener: function (name, handler) {
            listeners[name] = listeners[name] || [];
            listeners[name].push(handler);
        },
        removeEventListener: function (name, handler) {
            const list = listeners[name] || [];
            const at = list.indexOf(handler);
            if (at > -1) { list.splice(at, 1); }
        },
        __fire: function (name, detail) {
            (listeners[name] || []).slice().forEach(h => h({ detail: detail }));
        },
        __listenerCount: function (name) {
            return (listeners[name] || []).length;
        }
    };
    Object.assign(sandbox, opts.globals || {});
    if (opts.evidence) { sandbox.fodEvidence = opts.evidence; }
    if (opts.noLocalStorage) { delete sandbox.localStorage; }
    // Only where the page turns cookies on, so every other check runs in the
    // same context it always did.
    if (opts.model && opts.model._enableCookies) {
        if (!tab.cookies) { tab.cookies = {}; }
        sandbox.document = makeCookieDocument(tab.cookies);
    }
    // In a browser the window is the global object, so make it so here.
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    const script = render(Object.assign(
        { _userPrompt: false, _jsonObject: firstPayload },
        opts.model || {}));
    let error = null;
    try {
        vm.runInContext(script, context, { filename: 'JavaScriptResource.js' });
    } catch (err) {
        error = err;
    }
    if (error) {
        console.log('  page view threw: ' + error.stack.split(
            String.fromCharCode(10))[0]);
    }
    if (process.env.HARNESS_TRACE) {
        console.log('  log: ' + JSON.stringify(log));
    }
    return {
        context: sandbox, log: log, error: error,
        endpoint: endpoint, window: sandbox, tab: tab,
        // Load the same script into the same page again, which is what a
        // second script tag does.
        runAgain: function () {
            try {
                vm.runInContext(script, context,
                    { filename: 'JavaScriptResource.js' });
            } catch (err) {
                console.log('  second load threw: ' + err.message);
            }
        }
    };
}

(async function () {
    {
        const tab = makeTab();
        const first = pageView(tab);
        await settle();
        check('first page view dispatched one request',
            first.endpoint.count() === 1, 'count ' + first.endpoint.count());
        check('the request carried the snippet value',
            (first.endpoint.bodies[0] || '').includes('51D_testvalue=purple'),
            first.endpoint.bodies[0]);
        check('the request carried this page view\'s query evidence once',
            (first.endpoint.bodies[0].match(/mark=second/g) || []).length === 1,
            first.endpoint.bodies[0]);
        check('the request carried the session id and the sequence last',
            /session-id=abc-123&sequence=1$/.test(first.endpoint.bodies[0]),
            first.endpoint.bodies[0]);
        check('the record was stored under fod_inputs',
            typeof tab.session.data['fod_inputs'] === 'string',
            JSON.stringify(Object.keys(tab.session.data)));
        check('the record carries neither the session id nor the sequence',
            !tab.session.data['fod_inputs'].includes('session-id') &&
            !tab.session.data['fod_inputs'].includes('sequence'),
            tab.session.data['fod_inputs']);
        check('the record is the plain string of the inputs, not a hash',
            tab.session.data['fod_inputs'].includes('mark=second') &&
            tab.session.data['fod_inputs'].includes('51D_testvalue=purple'),
            tab.session.data['fod_inputs']);
        check('no storage key ends with _parameters',
            Object.keys(tab.session.data).every(k => !k.endsWith('_parameters')),
            JSON.stringify(Object.keys(tab.session.data)));

        const keysPage1 = Object.keys(tab.session.data).sort();

        // Second page view, same inputs. Nothing is sent and the keys do not
        // change, which is SessionStorageCache_SecondPageIsServedFromCache.
        const second = pageView(tab);
        await settle();
        check('an unchanged second page view sends nothing',
            second.endpoint.count() === 0, 'count ' + second.endpoint.count());
        check('an unchanged second page view leaves the key set alone',
            JSON.stringify(Object.keys(tab.session.data).sort()) ===
            JSON.stringify(keysPage1),
            JSON.stringify(Object.keys(tab.session.data).sort()));
        check('an unchanged second page view still sees the cached value',
            second.context.fod.device.testvalue === 'purple',
            String(second.context.fod.device.testvalue));
    }

    // A builder that also renders the session id and the sequence into the
    // script's parameters. Three of the six ports do, because the parameters
    // are built from every query evidence key and these two arrive as query
    // evidence like any other. The session id changes on every page view, so
    // a record that kept it could never match the next page view's and the
    // cached response could never be reused, which costs a request on every
    // page view for the life of the tab. The record leaves both out whatever
    // the parameters carried, so such a builder is served from the cache like
    // any other.
    {
        const tab = makeTab();
        const withSession = function (sessionId) {
            return {
                model: {
                    _sessionId: sessionId,
                    _parameters: JSON.stringify({
                        mark: 'second',
                        'session-id': sessionId,
                        sequence: '1'
                    })
                },
                responses: [secondPayload]
            };
        };

        const first = pageView(tab, withSession('abc-123'));
        await settle();
        check('a builder that renders the session id still dispatches once',
            first.endpoint.count() === 1, 'count ' + first.endpoint.count());
        check('the record leaves out a session id that came from the parameters',
            !tab.session.data['fod_inputs'].includes('session-id'),
            tab.session.data['fod_inputs']);
        check('the record leaves out a sequence that came from the parameters',
            !tab.session.data['fod_inputs'].includes('sequence'),
            tab.session.data['fod_inputs']);
        check('the record still carries the rest of the parameters',
            tab.session.data['fod_inputs'].includes('mark=second'),
            tab.session.data['fod_inputs']);

        // The second page view gets a new session id, as every page view does.
        const second = pageView(tab, withSession('def-456'));
        await settle();
        check('a second page view with a new session id sends nothing',
            second.endpoint.count() === 0, 'count ' + second.endpoint.count());
        check('a second page view with a new session id sees the cached value',
            second.context.fod.device.testvalue === 'purple',
            String(second.context.fod.device.testvalue));
    }

    {
        // Different query evidence is different inputs, so the entry goes and
        // the snippets run again on this page view.
        const tab = makeTab();
        const first = pageView(tab);
        await settle();
        const third = pageView(tab, {
            model: { _parameters: '{"mark":"third","id.usage":"personalized"}' }
        });
        await settle();
        check('changed query evidence clears the entry and refreshes',
            third.endpoint.count() === 1, 'count ' + third.endpoint.count());
        check('the refreshed request carries this page view\'s evidence only',
            third.endpoint.bodies[0].includes('mark=third') &&
            !third.endpoint.bodies[0].includes('mark=second'),
            third.endpoint.bodies[0]);
        check('the snippet ran again, so the value is in the new request',
            third.endpoint.bodies[0].includes('51D_testvalue=purple'),
            third.endpoint.bodies[0]);
    }

    {
        // A key given in both the script URL and the evidence object is sent
        // once, with the evidence object winning because it is read later.
        const tab = makeTab();
        const view = pageView(tab, { evidence: { 'id.usage': 'standard' } });
        await settle();
        const body = view.endpoint.bodies[0] || '';
        check('a key in both the URL and the evidence object is sent once',
            (body.match(/id\.usage=/g) || []).length === 1, body);
        check('the evidence object wins, being read last',
            body.includes('id.usage=standard'), body);
    }

    {
        // An evidence object the page changed between page views is different
        // inputs.
        const tab = makeTab();
        await settle();
        pageView(tab, { evidence: { 'id.email': 'a@example.com' } });
        await settle();
        const again = pageView(tab, { evidence: { 'id.email': 'b@example.com' } });
        await settle();
        check('a changed page evidence value is different inputs',
            again.endpoint.count() === 1, 'count ' + again.endpoint.count());
    }


// ---------------------------------------------------------------------------
section('The user prompt block');
// ---------------------------------------------------------------------------

const didPayload = JSON.stringify({
    device: { ismobile: true, testvalue: 'purple' },
    fodid: { fodid: 'ABC123' },
    javascriptProperties: []
});

// An endpoint whose responses are held until the test releases them, so that
// a round can be caught in progress.
function makeDeferredEndpoint() {
    const bodies = [];
    const waiting = [];
    function fetchStub(url, options) {
        bodies.push(options.body);
        let deliver;
        const held = new Promise(r => { deliver = r; });
        waiting.push(deliver);
        return held.then(t => ({
            ok: true, status: 200, text: () => Promise.resolve(t)
        }));
    }
    return {
        fetch: fetchStub, bodies: bodies,
        count: () => bodies.length,
        release: function (t) { (waiting.shift())(t); }
    };
}

// A framework stub that keeps the callback so the test can deliver later, and
// optionally calls back at once the way a loaded platform must.
function makeFramework(immediate) {
    const held = { callback: null, calls: [] };
    held.api = function (command, version, callback) {
        held.calls.push(command);
        if (command === 'addEventListener') {
            held.callback = callback;
            if (immediate) { callback(immediate.data, immediate.success); }
        }
    };
    held.deliver = function (data, success) {
        if (held.callback) { held.callback(data, success); }
    };
    return held;
}

function logged(result, text) {
    return result.log.some(e => String(e[1]).indexOf(text) !== -1);
}

{
    // 1. No answer at construction, then a late preference event, which is the
    //    common case rather than a recovery path.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload]
    });
    await settle(12);
    check('no answer at construction still dispatches the first round',
        view.endpoint.count() === 1, 'count ' + view.endpoint.count());
    check('the first request carries no answer',
        view.endpoint.bodies[0].indexOf('id.usage') === -1,
        view.endpoint.bodies[0]);
    check('a page with no platform at construction is warned once',
        view.log.filter(e => String(e[1]).indexOf(
            '51Degrees: no preference platform') === 0).length === 1,
        JSON.stringify(view.log));
    check('no value is printed by the block',
        !logged(view, 'standard') && !logged(view, 'purple'),
        JSON.stringify(view.log));

    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('a late preference event produces one more request',
        view.endpoint.count() === 2, 'count ' + view.endpoint.count());
    check('the refreshed request carries the answer as a stated usage',
        view.endpoint.bodies[1].indexOf('id.usage=standard') !== -1,
        view.endpoint.bodies[1]);
    check('the refreshed request carries every snippet result',
        view.endpoint.bodies[1].indexOf('51D_testvalue=purple') !== -1,
        view.endpoint.bodies[1]);
    check('the refreshed request carries the next sequence number',
        /sequence=2$/.test(view.endpoint.bodies[1]),
        view.endpoint.bodies[1]);
    check('the identifier reaches the object on the promise path',
        view.context.fod.fodid.fodid === 'ABC123',
        String(view.context.fod.fodid && view.context.fod.fodid.fodid));
    check('the record beside the response is the record of that request',
        tab.session.data['fod_inputs'].indexOf('id.usage=standard') !== -1,
        tab.session.data['fod_inputs']);
}

{
    // 2. A late framework delivery, sent as tcstring and never mapped here.
    const tab = makeTab();
    const framework = makeFramework(null);
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload],
        globals: { __tcfapi: framework.api }
    });
    await settle(12);
    check('a framework stub at construction stops the missing platform warning',
        !logged(view, '51Degrees: no preference platform'),
        JSON.stringify(view.log));
    check('the block registers with addEventListener and calls nothing else',
        JSON.stringify(framework.calls) === '["addEventListener"]',
        JSON.stringify(framework.calls));
    check('the first round goes without waiting for the platform',
        view.endpoint.count() === 1, 'count ' + view.endpoint.count());

    framework.deliver({ eventStatus: 'useractioncomplete',
        tcString: 'CPtest.string' }, true);
    await settle(12);
    check('a late framework delivery produces one more request',
        view.endpoint.count() === 2, 'count ' + view.endpoint.count());
    check('the framework string is sent as tcstring, unmapped',
        view.endpoint.bodies[1].indexOf('tcstring=CPtest.string') !== -1,
        view.endpoint.bodies[1]);
}

{
    // 3. A delivery of (null, false) is never read as an answer.
    const tab = makeTab();
    const framework = makeFramework(null);
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload],
        globals: { __tcfapi: framework.api }
    });
    await settle(12);
    framework.deliver(null, false);
    await settle(12);
    check('(null, false) is not an answer and starts no request',
        view.endpoint.count() === 1, 'count ' + view.endpoint.count());

    framework.deliver({ eventStatus: 'cmpuishown', tcString: 'CPignored' }, true);
    await settle(12);
    check('a status other than tcloaded or useractioncomplete is ignored',
        view.endpoint.count() === 1, 'count ' + view.endpoint.count());

    framework.deliver({ eventStatus: 'tcloaded', tcString: 'CPreal' }, true);
    await settle(12);
    check('a tcloaded delivery with a string is an answer',
        view.endpoint.count() === 2 &&
        view.endpoint.bodies[1].indexOf('tcstring=CPreal') !== -1,
        view.endpoint.bodies[1]);
}

{
    // 4. A listener that fires synchronously inside its own registration. The
    //    first request carries the answer and no second round is needed.
    const tab = makeTab();
    const framework = makeFramework({
        data: { eventStatus: 'tcloaded', tcString: 'CPatonce' }, success: true
    });
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [didPayload],
        globals: { __tcfapi: framework.api }
    });
    await settle(12);
    check('a synchronous delivery is carried by the first request',
        view.endpoint.count() === 1 &&
        view.endpoint.bodies[0].indexOf('tcstring=CPatonce') !== -1,
        view.endpoint.count() + ' ' + view.endpoint.bodies[0]);
}

{
    // 5. refresh() while a round is in progress only marks it pending, and the
    //    round end then sends one request carrying the answer.
    const tab = makeTab();
    const endpoint = makeDeferredEndpoint();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        endpoint: endpoint
    });
    await settle(6);
    check('the first request is in flight', endpoint.count() === 1,
        'count ' + endpoint.count());
    view.context.__fire('51d-pmp-preference', { preference: 'personalized' });
    await settle(6);
    check('an answer arriving mid round sends nothing of its own yet',
        endpoint.count() === 1, 'count ' + endpoint.count());
    endpoint.release(secondPayload);
    await settle(12);
    check('the round end sends exactly one request for the pending answer',
        endpoint.count() === 2, 'count ' + endpoint.count());
    check('that request carries the answer and the snippet result',
        endpoint.bodies[1].indexOf('id.usage=personalized') !== -1 &&
        endpoint.bodies[1].indexOf('51D_testvalue=purple') !== -1,
        endpoint.bodies[1]);
    endpoint.release(didPayload);
    await settle(12);
    check('no further request follows', endpoint.count() === 2,
        'count ' + endpoint.count());
}

{
    // 6. refresh() with unchanged inputs does nothing.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload]
    });
    await settle(12);
    const before = view.endpoint.count();
    view.context.fod.refresh();
    await settle(12);
    check('refresh() with unchanged inputs sends nothing',
        view.endpoint.count() === before,
        before + ' -> ' + view.endpoint.count());

    // Firing the same answer twice is also unchanged inputs.
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    const afterFirst = view.endpoint.count();
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('the same answer delivered twice sends one request, not two',
        view.endpoint.count() === afterFirst,
        afterFirst + ' -> ' + view.endpoint.count());
}

{
    // 7. refresh() at the iteration cap logs and does nothing.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _sequence: 10,
            _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload]
    });
    await settle(12);
    const before = view.endpoint.count();
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('at the iteration cap an answer starts no request',
        view.endpoint.count() === before,
        before + ' -> ' + view.endpoint.count());
    check('at the iteration cap refresh() logs the guard string',
        logged(view, '51Degrees: the maximum of'), JSON.stringify(view.log));
    check('the logged message names the maximum and says nothing happens',
        logged(view, '51Degrees: the maximum of 10 iterations for this page ' +
            'view has been reached, refresh() does nothing.'),
        JSON.stringify(view.log));
}

{
    // 8. The guard string is in the rendered script itself, with the block on
    //    and with it off, so a test can prove which template it loaded.
    const on = render({ _userPrompt: true });
    const off = render({ _userPrompt: false });
    check('the guard string is in the rendered script with the block on',
        on.indexOf('51Degrees: the maximum of') !== -1);
    check('the guard string is in the rendered script with the block off',
        off.indexOf('51Degrees: the maximum of') !== -1);
    check('the block is absent when the section is not set',
        off.indexOf('__51d_pmp') === -1 && off.indexOf('__tcfapi') === -1,
        'block text leaked into the unset render');
    check('the block is present when the section is set',
        on.indexOf('__51d_pmp') !== -1 && on.indexOf('__tcfapi') !== -1);
    check('no GPP code is in the rendered script',
        on.indexOf('__gpp') === -1, 'found __gpp');
    check('the iteration cap in the template is 10, as MAX_JAVASCRIPT_ITERATIONS',
        /var maxIterations = 10;/.test(template));
}

{
    // 9. The one instance warning. Loading the script twice into one page
    //    warns and names the object and nothing else.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload]
    });
    await settle(12);
    check('the first load does not warn about an existing instance',
        !logged(view, 'already exists on this page'), JSON.stringify(view.log));
    check('var fod created the global property on the window',
        typeof view.context.fod !== 'undefined');
    const before = view.log.length;
    view.runAgain();
    await settle(12);
    const warning = view.log.slice(before).filter(
        e => String(e[1]).indexOf('already exists on this page') !== -1);
    check('a second load warns exactly once', warning.length === 1,
        JSON.stringify(view.log.slice(before)));
    check('the warning names the object and prints no payload',
        warning.length === 1 &&
        warning[0][1] === '51Degrees: fod already exists on this page. ' +
        'Loading the script twice replaces it. Load it once and call ' +
        'fod.refresh() to update.',
        warning.length ? warning[0][1] : '');
}

{
    // 10. No answer yet means unknown, not different. The stored record's
    //     answer stands in while a platform is present but silent.
    const tab = makeTab();
    const platform = { preference: function () { return 'standard'; } };
    const first = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [didPayload],
        globals: { __51d_pmp: platform }
    });
    await settle(12);
    check('the platform getter answers synchronously at construction',
        first.endpoint.count() === 1 &&
        first.endpoint.bodies[0].indexOf('id.usage=standard') !== -1,
        first.endpoint.bodies[0]);

    // A second page view whose platform is loaded but has not answered yet.
    const silent = { preference: function () { return null; } };
    const second = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [didPayload],
        globals: { __51d_pmp: silent }
    });
    await settle(12);
    check('a silent platform serves the stored entry rather than refreshing',
        second.endpoint.count() === 0, 'count ' + second.endpoint.count());
    second.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('the same answer arriving later still sends nothing',
        second.endpoint.count() === 0, 'count ' + second.endpoint.count());
    second.context.__fire('51d-pmp-preference', { preference: 'personalized' });
    await settle(12);
    check('a different answer arriving later sends one request',
        second.endpoint.count() === 1 &&
        second.endpoint.bodies[0].indexOf('id.usage=personalized') !== -1,
        second.endpoint.count() + ' ' + second.endpoint.bodies[0]);

    // A third page view with no platform at all keeps the literal reading.
    const third = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [didPayload]
    });
    await settle(12);
    check('a page with no platform at all refreshes rather than standing in',
        third.endpoint.count() === 1, 'count ' + third.endpoint.count());
}

{
    // 11. The answer replaces what the URL carried and the GPP keys go.
    const tab = makeTab();
    const platform = { preference: function () { return 'standard'; } };
    const view = pageView(tab, {
        model: { _userPrompt: true,
            _parameters: '{"id.usage":"personalized","gpp":"DBABzw","gppstring":"x","tcstring":"CPold"}' },
        responses: [didPayload],
        globals: { __51d_pmp: platform }
    });
    await settle(12);
    const body = view.endpoint.bodies[0];
    check('the answer replaces the usage the script URL carried',
        (body.match(/id\.usage=/g) || []).length === 1 &&
        body.indexOf('id.usage=standard') !== -1, body);
    check('a consent string beside a stated usage is not sent',
        body.indexOf('tcstring=') === -1, body);
    check('neither gpp nor gppstring is sent',
        body.indexOf('gpp=') === -1 && body.indexOf('gppstring=') === -1, body);
}

{
    // 12. A change of answer in one page view, standard then the alternative.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload, didPayload]
    });
    await settle(12);
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    view.context.__fire('51d-pmp-preference', { preference: 'non-marketing' });
    await settle(12);
    check('a change of mind in one page view sends a third request',
        view.endpoint.count() === 3, 'count ' + view.endpoint.count());
    check('the alternative answer is sent as a usage, not a refusal',
        view.endpoint.bodies[2].indexOf('id.usage=non-marketing') !== -1,
        view.endpoint.bodies[2]);
    view.context.__fire('51d-pmp-preference', { preference: 'something-else' });
    await settle(12);
    check('an unknown preference value sends nothing new, and the previous ' +
        'answer stands',
        view.endpoint.count() === 3, 'count ' + view.endpoint.count());
}

{
    // 13. The local storage entry covers a script that constructs before the
    //     platform's bundle has loaded on a site where the visitor answered.
    const tab = makeTab();
    tab.local.data['__51d_pmp_pref'] =
        JSON.stringify({ v: 1, p: 'personalized', t: 1 });
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [didPayload]
    });
    await settle(12);
    check('a stored preference is read at construction',
        view.endpoint.bodies[0].indexOf('id.usage=personalized') !== -1,
        view.endpoint.bodies[0]);

    // An entry that does not parse is no answer from that source.
    const tab2 = makeTab();
    tab2.local.data['__51d_pmp_pref'] = 'not json';
    const view2 = pageView(tab2, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload]
    });
    await settle(12);
    check('an unparsable stored preference throws nothing and is no answer',
        view2.error === null &&
        view2.endpoint.bodies[0].indexOf('id.usage') === -1,
        view2.error ? String(view2.error) : view2.endpoint.bodies[0]);
}

{
    // 14. A failed request ends the round, so a pending answer still gets one.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [{ status: 500 }, didPayload]
    });
    await settle(12);
    check('a failed request leaves nothing behind in session storage',
        Object.keys(tab.session.data).length === 0,
        JSON.stringify(Object.keys(tab.session.data)));
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('an answer after a failed round still gets a request',
        view.endpoint.count() === 2, 'count ' + view.endpoint.count());
    check('that request carries the answer',
        view.endpoint.bodies[1].indexOf('id.usage=standard') !== -1,
        view.endpoint.bodies[1]);
}

{
    // 15. A platform whose every call throws must not stop processing.
    const tab = makeTab();
    const angry = function () { throw new Error('stub is broken'); };
    const view = pageView(tab, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload],
        globals: { __tcfapi: angry }
    });
    await settle(12);
    check('a platform stub that throws does not stop the first round',
        view.error === null && view.endpoint.count() === 1,
        view.error ? String(view.error) : 'count ' + view.endpoint.count());
    check('the throwing call is named in a warning',
        logged(view, "the call to __tcfapi('addEventListener') threw"),
        JSON.stringify(view.log));
}

{
    // 16. Storage that throws on every read must not stop processing.
    const session = makeStorage({ throwOnRead: true });
    const local = makeStorage({ throwOnRead: true });
    const view = pageView({ session: session, local: local }, {
        model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
        responses: [secondPayload]
    });
    await settle(12);
    check('storage that throws on read does not stop the first round',
        view.error === null && view.endpoint.count() === 1,
        view.error ? String(view.error) : 'count ' + view.endpoint.count());
}


{
    // 17. The path without fetch, which every browser test that disables
    //     fetch takes, and which carries its own failure exits.
    function makeXhrEndpoint(responses) {
        const bodies = [];
        let round = 0;
        function XhrStub() {
            this.status = 200;
            this.responseText = '';
            this.withCredentials = false;
        }
        XhrStub.prototype.open = function () {};
        XhrStub.prototype.setRequestHeader = function () {};
        XhrStub.prototype.send = function (body) {
            bodies.push(body);
            const answer = responses[Math.min(round, responses.length - 1)];
            round++;
            const self = this;
            setTimeout(function () {
                if (answer && answer.status) {
                    self.status = answer.status;
                    self.responseText = '';
                } else {
                    self.status = 200;
                    self.responseText = answer;
                }
                self.onload();
            }, 0);
        };
        return {
            XMLHttpRequest: XhrStub, bodies: bodies,
            count: () => bodies.length, fetch: undefined
        };
    }

    const tab = makeTab();
    const xhr = makeXhrEndpoint([secondPayload, didPayload]);
    const view = pageView(tab, {
        model: { _userPrompt: true, _supportsFetch: false,
            _parameters: '{"mark":"one"}' },
        endpoint: xhr,
        globals: { XMLHttpRequest: xhr.XMLHttpRequest }
    });
    await settle(12);
    check('the path without fetch dispatches the first round',
        xhr.count() === 1, 'count ' + xhr.count());
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('the path without fetch refreshes on a late answer',
        xhr.count() === 2 &&
        xhr.bodies[1].indexOf('id.usage=standard') !== -1,
        xhr.count() + ' ' + xhr.bodies[1]);

    const failing = makeXhrEndpoint([{ status: 503 }, didPayload]);
    const tab2 = makeTab();
    const view2 = pageView(tab2, {
        model: { _userPrompt: true, _supportsFetch: false,
            _parameters: '{"mark":"one"}' },
        endpoint: failing,
        globals: { XMLHttpRequest: failing.XMLHttpRequest }
    });
    await settle(12);
    check('a failed request on the path without fetch clears the cache',
        Object.keys(tab2.session.data).length === 0,
        JSON.stringify(Object.keys(tab2.session.data)));
    view2.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('a pending answer still gets a request after that failure',
        failing.count() === 2, 'count ' + failing.count());
}

{
    // 18. The path without promises. The object has to publish a later
    //     response too, which it did not before update moved into
    //     loadParsedJSON.
    const tab = makeTab();
    const view = pageView(tab, {
        model: { _userPrompt: true, _supportsPromises: false,
            _parameters: '{"mark":"one"}' },
        responses: [secondPayload, didPayload]
    });
    await settle(12);
    check('the path without promises dispatches the first round',
        view.endpoint.count() === 1, 'count ' + view.endpoint.count());
    check('the path without promises publishes the first response',
        view.context.fod.device.testvalue === 'purple',
        String(view.context.fod.device.testvalue));
    view.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('the path without promises publishes the refreshed response',
        view.context.fod.fodid && view.context.fod.fodid.fodid === 'ABC123',
        JSON.stringify(view.context.fod.fodid));
    let seen = null;
    view.context.fod.complete(function (data) { seen = data; });
    check('complete registered after a refresh is called',
        seen !== null && seen.fodid.fodid === 'ABC123', JSON.stringify(seen));
}

{
    // 19. The exit taken where the browser makes no cross origin request at
    //     all, so createCORSRequest answers null. It has to end the round the
    //     way every other failure exit does, or an answer that arrives before
    //     the failure is reported is left waiting on a round that never ends.
    //     With no XMLHttpRequest in the context at all, and no XDomainRequest
    //     either, createCORSRequest catches the reference error and answers
    //     null, which is the exit under test.
    const tab = makeTab();
    const view = pageView(tab, {
        model: {
            _userPrompt: true, _supportsFetch: false,
            _parameters: '{"mark":"one"}'
        },
        endpoint: { fetch: undefined, bodies: [], count: () => 0 }
    });
    await settle(12);
    check('the exit with no cross origin support clears the cache',
        Object.keys(tab.session.data).length === 0,
        JSON.stringify(Object.keys(tab.session.data)));
    check('the message that exit reports is unchanged',
        logged(view, 'CORS not supported'), JSON.stringify(view.log));

    // The same exit on a page whose visitor answers in the same turn as the
    // construction, before the failure has been reported. A round that never
    // ended swallows that refresh. The stub throws on its first construction
    // and works afterwards, so the request the refresh makes can be counted.
    const bodies = [];
    let constructions = 0;
    function XhrStub() {
        constructions++;
        if (constructions === 1) { throw new Error('no XMLHttpRequest here'); }
        this.status = 200;
        this.responseText = '';
        this.withCredentials = false;
    }
    XhrStub.prototype.open = function () {};
    XhrStub.prototype.setRequestHeader = function () {};
    XhrStub.prototype.send = function (body) {
        bodies.push(body);
        const self = this;
        setTimeout(function () {
            self.status = 200;
            self.responseText = didPayload;
            self.onload();
        }, 0);
    };

    const tab2 = makeTab();
    const answered = pageView(tab2, {
        model: {
            _userPrompt: true, _supportsFetch: false,
            _parameters: '{"mark":"one"}'
        },
        endpoint: {
            fetch: undefined, bodies: bodies,
            count: () => bodies.length
        },
        globals: { XMLHttpRequest: XhrStub }
    });
    answered.context.__fire('51d-pmp-preference', { preference: 'standard' });
    await settle(12);
    check('an answer arriving at that exit still gets a request',
        bodies.length === 1 &&
        (bodies[0] || '').indexOf('id.usage=standard') !== -1,
        bodies.length + ' ' + bodies[0]);
    check('the identifier from that request reaches the object',
        answered.context.fod.fodid &&
        answered.context.fod.fodid.fodid === 'ABC123',
        JSON.stringify(answered.context.fod.fodid));
}


// ---------------------------------------------------------------------------
section('An answer known at construction, with no snippet that saves a value');
// ---------------------------------------------------------------------------
{
    // The hardware profile snippet, which runs and saves no profile ids, so
    // processJsProperties backs its count out again.
    const profileSnippet =
        'window.hardwareProfileRuns = (window.hardwareProfileRuns || 0) + 1;';
    const profileOnlyPayload = JSON.stringify({
        device: {
            ismobile: true,
            javascripthardwareprofile: profileSnippet
        },
        javascriptProperties: ['device.javascripthardwareprofile']
    });
    const noSnippetPayload = JSON.stringify({
        device: { ismobile: true },
        javascriptProperties: []
    });
    const answered = { preference: function () { return 'standard'; } };

    // A page whose only snippet is the hardware profile, which runs and
    // saves nothing.
    {
        const tab = makeTab();
        // The server lists the snippet again while the sequence is below its
        // maximum, so the answer round's response carries it too. That is
        // what would make the snippet run a second time.
        const didAndProfilePayload = JSON.stringify({
            device: {
                ismobile: true,
                javascripthardwareprofile: profileSnippet
            },
            fodid: { fodid: 'ABC123' },
            javascriptProperties: ['device.javascripthardwareprofile']
        });
        const view = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}',
                _jsonObject: profileOnlyPayload },
            responses: [didAndProfilePayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        check('the hardware profile snippet ran',
            view.context.hardwareProfileRuns === 1,
            'runs ' + view.context.hardwareProfileRuns);
        check('a snippet that saves nothing still sends the answer',
            view.endpoint.count() === 1, 'count ' + view.endpoint.count());
        check('that request carries the answer',
            (view.endpoint.bodies[0] || '').indexOf('id.usage=standard') !== -1,
            view.endpoint.bodies[0]);
        check('the identifier comes back on that page',
            view.context.fod.fodid && view.context.fod.fodid.fodid === 'ABC123',
            JSON.stringify(view.context.fod.fodid));
        check('the hardware profile snippet did not run a second time',
            view.context.hardwareProfileRuns === 1,
            'runs ' + view.context.hardwareProfileRuns);
    }

    // A page with no JavaScript property at all.
    {
        const tab = makeTab();
        const view = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}',
                _jsonObject: noSnippetPayload },
            responses: [didPayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        check('a page with no snippet at all still sends the answer',
            view.endpoint.count() === 1, 'count ' + view.endpoint.count());
        check('that request carries the answer and nothing else new',
            /^mark=one&id\.usage=standard&session-id=[^&]+&sequence=1$/
                .test(view.endpoint.bodies[0] || ''),
            view.endpoint.bodies[0]);
        check('no further request follows on a page with no snippet',
            view.endpoint.count() === 1, 'count ' + view.endpoint.count());
    }

    // The same two pages with no answer must still send nothing, which is
    // what they do today and what every page without the block does.
    {
        const tab = makeTab();
        const view = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}',
                _jsonObject: noSnippetPayload },
            responses: [didPayload]
        });
        await settle(14);
        check('a page with no snippet and no answer sends nothing',
            view.endpoint.count() === 0, 'count ' + view.endpoint.count());
    }
    {
        const tab = makeTab();
        const view = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}',
                _jsonObject: profileOnlyPayload },
            responses: [didPayload]
        });
        await settle(14);
        check('a snippet that saves nothing and no answer sends nothing',
            view.endpoint.count() === 0, 'count ' + view.endpoint.count());
    }

    // A page whose own script request already carried the answer has nothing
    // new to send, so it must stay at zero requests.
    {
        const tab = makeTab();
        const view = pageView(tab, {
            model: { _userPrompt: true,
                _parameters: '{"mark":"one","id.usage":"standard"}',
                _jsonObject: noSnippetPayload },
            responses: [didPayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        check('a script URL that already carried the answer sends nothing',
            view.endpoint.count() === 0, 'count ' + view.endpoint.count());
    }

    // The ordinary page, where a snippet saves a value, must stay at one
    // request rather than becoming two.
    {
        const tab = makeTab();
        const view = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
            responses: [didPayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        check('the ordinary page with an answer stays at one request',
            view.endpoint.count() === 1, 'count ' + view.endpoint.count());
        check('that one request carries the answer and the snippet result',
            view.endpoint.bodies[0].indexOf('id.usage=standard') !== -1 &&
            view.endpoint.bodies[0].indexOf('51D_testvalue=purple') !== -1,
            view.endpoint.bodies[0]);
    }

    // A second page view in the same tab, served from the cache, must not
    // send the answer again.
    {
        const tab = makeTab();
        const first = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
            responses: [didPayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        const second = pageView(tab, {
            model: { _userPrompt: true, _parameters: '{"mark":"one"}' },
            responses: [didPayload],
            globals: { __51d_pmp: answered }
        });
        await settle(14);
        check('a cached second page view with the same answer sends nothing',
            second.endpoint.count() === 0, 'count ' + second.endpoint.count());
    }
}



// ---------------------------------------------------------------------------
section('Every snippet that runs leaves a result');
// ---------------------------------------------------------------------------
{
    // The shape of the high entropy values snippet that matters, being a store
    // inside a branch the browser does not take. The snippet runs, stores
    // nothing, and the server hears nothing about it unless an empty result is
    // stored for the name.
    const quietSnippet =
        'if (window.__neverSet) { document.cookie = "51D_quiet=" + "x"; }';
    const quietPayload = JSON.stringify({
        device: { ismobile: true, quietjavascript: quietSnippet },
        javascriptProperties: ['device.quietjavascript']
    });

    const tab = makeTab();
    const view = pageView(tab, {
        model: { _jsonObject: quietPayload },
        responses: [secondPayload]
    });
    await settle(12);
    check('a snippet that stores nothing still sends a result for its name',
        (view.endpoint.bodies[0] || '').indexOf('51D_quiet=') !== -1,
        view.endpoint.bodies[0]);
    check('the result it sends is empty',
        /(^|&)51D_quiet=(&|$)/.test(view.endpoint.bodies[0] || ''),
        view.endpoint.bodies[0]);
    check('the record beside the response carries that empty result',
        (tab.session.data['fod_inputs'] || '').indexOf('51D_quiet=') !== -1,
        tab.session.data['fod_inputs']);

    // The second page view builds its inputs from the same stored values, so
    // the record matches and the cached response stands. This holds either way
    // and is here to catch an empty result written after the record rather
    // than before it, which would clear the cache on every page view.
    const second = pageView(tab, {
        model: { _jsonObject: quietPayload },
        responses: [secondPayload]
    });
    await settle(12);
    check('a second page view with that snippet is served from the cache',
        second.endpoint.count() === 0, 'count ' + second.endpoint.count());

    // A snippet that does store a value must send the value, because the
    // empty result is written before the snippet runs.
    const tab2 = makeTab();
    const stores = pageView(tab2, { responses: [secondPayload] });
    await settle(12);
    check('a snippet that stores a value sends the value, not an empty one',
        (stores.endpoint.bodies[0] || '')
            .indexOf('51D_testvalue=purple') !== -1,
        stores.endpoint.bodies[0]);
}


// ---------------------------------------------------------------------------
section('A page whose publisher turned cookies on');
// ---------------------------------------------------------------------------
{
    // The store sits in a branch the browser does not take, so the snippet
    // runs and writes no cookie of its own.
    const quietSnippet =
        'if (window.__neverSet) { document.cookie = "51D_quiet=" + "x"; }';
    const quietPayload = JSON.stringify({
        device: { ismobile: true, quietjavascript: quietSnippet },
        javascriptProperties: ['device.quietjavascript']
    });

    const tab = makeTab();
    const view = pageView(tab, {
        model: { _enableCookies: true, _jsonObject: quietPayload },
        responses: [secondPayload]
    });
    await settle(12);
    check('a cookie page whose snippet stores nothing sends an empty result',
        /(^|&)51D_quiet=(&|$)/.test(view.endpoint.bodies[0] || ''),
        view.endpoint.bodies[0]);
    check('the empty result is kept in session storage, not in a cookie',
        Object.keys(tab.cookies).length === 0 &&
        tab.session.data['fod_data_51D_quiet'] === '',
        JSON.stringify(tab.cookies) + ' ' +
        JSON.stringify(Object.keys(tab.session.data)));

    // A snippet that does write its cookie must send the cookie's value and
    // not the empty result written before it ran.
    const tab2 = makeTab();
    const stores = pageView(tab2, {
        model: { _enableCookies: true },
        responses: [secondPayload]
    });
    await settle(12);
    check('a cookie page whose snippet stores a value sends the value',
        (stores.endpoint.bodies[0] || '')
            .indexOf('51D_testvalue=purple') !== -1,
        stores.endpoint.bodies[0]);
    check('the snippet wrote that value as a cookie',
        tab2.cookies['51D_testvalue'] === 'purple',
        JSON.stringify(tab2.cookies));

    // Five ports assert the number of document.cookie occurrences in the
    // rendered script, being the template's own read plus the one the
    // payload's snippet carries. The expectation is pinned here as well, so a
    // change that adds a write of our own is caught before it takes
    // pipeline-dotnet, pipeline-java, pipeline-node, pipeline-python and
    // pipeline-php-core red.
    const portsPayload = JSON.stringify({
        device: {
            ismobile: true,
            testvaluejavascript: 'document.cookie = "51D_testvalue=" + "purple"'
        },
        javascriptProperties: ['device.testvaluejavascript']
    });
    const occurrences = s => (s.match(/document\.cookie/g) || []).length;
    const withCookies = occurrences(render({
        _enableCookies: true, _jsonObject: portsPayload
    }));
    const withoutCookies = occurrences(render({
        _enableCookies: false, _jsonObject: portsPayload
    }));
    check('two document.cookie in the rendered script with cookies on',
        withCookies === 2, 'count ' + withCookies);
    check('one document.cookie in the rendered script with cookies off',
        withoutCookies === 1, 'count ' + withoutCookies);
}

    console.log('\n' + checks + ' checks, ' + failures + ' failures');
    process.exit(failures === 0 ? 0 : 1);
})();
