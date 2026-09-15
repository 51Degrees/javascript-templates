## Purpose

Store shared (mustache) templates to be used by the implementation of `JavaScriptBuilderElement` and other components across the languages. 

## Background

The [language-independent specification](https://github.com/51Degrees/specifications) describes how JavaScriptBuilderElement is used [here](https://github.com/51Degrees/specifications/blob/36ff732360acb49221dc81237281264dac4eb897/pipeline-specification/pipeline-elements/javascript-builder.md). The mechanics is: javascript file is requested from the server (on-premise web integration) and is created from this mustache template by the JavaScriptBuilderElement. It then collects more evidence, sends it to the server and upon response calls a callback function providing the client with more precise device data.

## Cookies -> Session storage Transformation 

The processJsProperties function in javascript template has a section that uses regex to search the injected JavaScript for any commands that set cookie values to the browser's document object. It then transforms this command so that it sets session storage values instead. This format should be accounted for when writing JavaScript properties. 

---

### Cookie Transformation regular expression rules

#### Valid Format for Cookie Statements:
- **Cookie Assignment**: The expression should start with `document.cookie = `
- **Spaces**: Spaces around the first `=` sign are optional
- **Cookie Name**: The name of the cookie should only contain alphanumeric characters, underscores, and must not have spaces
- **Assignment with Double Quotes**: The cookie value assignment can use double quotes, and the value should be set programmatically by concatenating a string with a variable or expression
- **Assignment with Backticks**: The cookie value assignment can use backticks for template literals, and the value can be set programmatically using expressions inside `${}`
- **No Direct Value Assignment**: Directly setting a value within the string is not allowed; values must be set programmatically

#### Regular Expression:
```javascript
/document\.cookie\s*=\s*(("([A-Za-z0-9_"\s\+]+)\s*=\s*"\s*\+\s*([^\s};]+))|(`([A-Za-z0-9_]+)\s*=\s*\$\{([^}]+)\}`))/g
```

#### Valid Examples:
```javascript
document.cookie="51D_PropertyName="+"True"; // No spaces around the equals and/or plus sign
document.cookie = "51D_PropertyName=" + "True"; // Spaces around the equals sign
document.cookie = "51D_PropertyName=" + screen.height; // Assigning a value using a variable
document.cookie="51D_PropertyName="+screen.height; // No spaces, variable assignment
document.cookie=`51D_PropertyName=${btoa(JSON.stringify(value))}` // Using a template literal with an expression
document.cookie="51D_PropertyName="+profileIds.join("|") // Assigning a value using a joined string of variables
document.cookie = `51D_PropertyName=${"True"}`; // Using backticks for programmatic value assignment
```

#### Invalid Examples:
```javascript
document.cookie = "51D_PropertyName=True"; // Direct assignment within the string is not allowed
document.cookie = "51D_PropertyName=" + profileIds.join(" ") // Spaces within the expression are not allowed
document.cookie = "  51D_PropertyName  = " + "True"; // Spaces inside the cookie name are not allowed
document.cookie = `  51D_PropertyName  =${"True"}`; // Spaces inside the template literal are not allowed
document.cookie = `51D_PropertyName=START${window.middle}END`; // Concatenating strings directly within template literals is not allowed
```
---

## CSP Considerations
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) is an added layer of security to mitigate cross-site and other types of attacks.  CSP limits which 3rd party resources are loaded and what these resources are allowed to do.  51Degrees JavaScript produced from the template is usually such a 3rd party resource when hosted on [51Degrees cloud](https://cloud.51degrees.com/api-docs/index.html).  If CSP header specifies [script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src) it has to list 51Degrees cloud origin as a source and also add 'unsafe-eval' as a source.

`'unsafe-eval'` source is needed because the template loads and executes dynamic javascript code snippets relying on JavaScript Function API which is in the eval() family. The snippets are part of the data file and are frequently updated to support latest changes in the browsers. Snippet execution may cause multiple server calls to load more dynamic code (in theory, in practice it usually comes down to a single server call) - thus this code can not be statically included in the template and has to be loaded dynamically as part of the JSON response of the server. 

## Page-supplied evidence

A page can pass extra evidence for the JSON refresh request by defining a
plain string-to-string object named `<ObjectName>Evidence` (default
`fodEvidence`, named after the JavaScriptBuilderElement `ObjectName` option)
before the script executes:

    <script>
      window.fodEvidence = { 'id.email': 'user@example.com' };
    </script>
    <script src=".../resource.js?id.usage=personalized"></script>

Each key and value is url-encoded and added to the form-data body of the
POST request. The parameters the script URL itself was requested with are
sent as form fields in that same body, and the two sources are merged into
one set before the body is built, so every key is sent exactly once and a key
given in both places takes the value from `<ObjectName>Evidence`, which is
read last. Avoid the keys the request already carries, `session-id` and
`sequence`, because those two are added after the merged set and a key of the
same name would then be sent twice.

Values must be strings. Anything else is coerced by the usual JavaScript
string conversion before it is sent, so a nested object arrives as
`[object Object]`, and an array assigned to `<ObjectName>Evidence` is sent
with its indices as the keys.

The evidence itself is never put in the URL or in a cookie. One copy of it is
kept, being the record of the inputs of the last request, which is every key
and value the body carried apart from `session-id` and `sequence`, with
`id.email` included where the page supplied it. That record is held in
session storage on the publisher's origin under `<ObjectName>_inputs` as the
plain string, so that a stored answer is never reused for different inputs.
Session storage on the publisher's origin is reachable only by the joint
controllers, being the publisher and 51Degrees, which is why the record is
kept as it stands and is not hashed. A hash would be read as a privacy
measure and it is not one. The JSON response the evidence produces is cached
in session storage verbatim for the lifetime of the tab as well, so any
personalised content the server returns is stored on the device.

Evidence is only sent when the script makes its JSON refresh request. With
updates disabled, or when a cached response covers the page view, there is
no request to carry it.

## What the script keeps in session storage

Every key is named after the object name, so an invalidated entry takes all
of them with it.

| Key | What it holds |
| --- | --- |
| `<ObjectName>` | The last JSON response, verbatim |
| `<ObjectName>_inputs` | The record of the inputs of the request that produced that response |
| `<ObjectName>_data_<name>` | A value a JavaScript snippet produced, where cookies are disabled |
| `<ObjectName>_property_<name>` | A flag saying a snippet has run and its result has reached the server |

The record under `<ObjectName>_inputs` is compared with this page view's own
inputs once, in the constructor, before the first request. Where the two
match the stored response is reused and nothing is sent. Where they differ
every key above is removed, so the snippets run again on this page view and a
fresh request is made, which is what stops an answer given for one set of
inputs being reused for another. A publisher who puts a cache buster in the
script URL therefore invalidates on every page view, because the cache buster
lands in the rendered parameters and so in the record.

## One object name per integration

Two integrations on one origin must use distinct object names, set through
the JavaScriptBuilderElement `ObjectName` option. Everything the script keeps
in session storage is named after the object, so two integrations sharing the
default `fod` share the cached payload, the snippet values, the snippet flags
and the record of the last request's inputs. Each one's inputs differ from
the record the other wrote, so they clear each other's entry on every page
view and each pays a full round it did not need.

## Tests

The template is not executable on its own, and every port only sees it once
it has been embedded, so `tests/template-tests.js` renders it here with a
model matching the one the .NET builder passes and then reads and drives the
rendered script. It proves three things. The formatting constraints each
port's own tests enforce, being the closing constructor line, the
`document.cookie` count, no mustache braces left in the output and no
trailing whitespace. That the script evaluates where there is no `window`,
`localStorage` or `sessionStorage` at all, which is the environment the
cloud's NiL.JS builder runs it in. And the behaviour a 51Did depends on,
driven against a fake endpoint, being one request body with each key sent
once, the record of the inputs that throws away a stale answer, the visitor's
answer reaching the request, `refresh()`, and the failure paths.

Run it with Node 24 from the `tests` directory.

    cd tests
    npm ci
    npm test

Each check prints a line and the last line gives the totals. The
`Template tests` workflow runs the same command on every pull request, and
the `Consumer tests` workflow builds pipeline-dotnet against the template and
runs the tests that drive it in a real browser.

## Shipping / Deployment

This repo is not a stand-alone package, but is shipped as part of and used by each of the following repositories / packages:
- [pipeline-dotnet](https://github.com/51Degrees/pipeline-dotnet) as a submodule
- [pipeline-java](https://github.com/51Degrees/pipeline-java) as a submodule
- [pipeline-node](https://github.com/51Degrees/pipeline-node) as a submodule
- [pipeline-python](https://github.com/51Degrees/pipeline-python) as a submodule
- [pipeline-php-core](https://github.com/51Degrees/pipeline-php-core) as a static dependency

Wherever it is a submodule it will be updated by `Nightly Submodule Update` action, wherever it is a static dependency it will be updated by the `Nightly Package Update` action within a target repository.

No special action is needed from the user to deploy the template, just be aware that any changes introduced in this repo will automatically propagate and affect the above packages. 
