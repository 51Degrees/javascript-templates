/* *********************************************************************
 * This Original Work is copyright of 51 Degrees Mobile Experts Limited.
 * Copyright 2026 51 Degrees Mobile Experts Limited, Davidson House,
 * Forbury Square, Reading, Berkshire, United Kingdom RG1 3EU.
 *
 * This Original Work is licensed under the European Union Public Licence
 * (EUPL) v.1.2 and is subject to its terms as set out below.
 *
 * If a copy of the EUPL was not distributed with this file, You can obtain
 * one at https://opensource.org/licenses/EUPL-1.2.
 *
 * The 'Compatible Licences' set out in the Appendix to the EUPL (as may be
 * amended by the European Commission) shall be deemed incompatible for
 * the purposes of the Work and the provisions of the compatibility
 * clause in Article 5 of the EUPL shall not apply.
 *
 * If using the Work as, or as part of, a network application, by
 * including the attribution notice(s) required under Article 5 of the EUPL
 * in the end user terms of the application under an appropriate heading,
 * such notice(s) shall fulfill the requirements of that article.
 * ********************************************************************* */

using Microsoft.VisualStudio.TestTools.UnitTesting;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using Stubble.Core.Builders;
using System.Collections;
using System.Collections.Generic;
using System.Net;

namespace FiftyOne.JavascriptTemplateTests;

[TestClass]
public class SnippetTests
{
    private static ChromeDriver _driver = null!;
    private static string _baseDir = null!;
    private static string _template = null!;

    [ClassInitialize]
    public static void ClassInit(TestContext context)
    {
        _baseDir = FindBaseDirectory();
        _template = File.ReadAllText(Path.Combine(_baseDir, "JavaScriptResource.mustache"));
        _driver = CreateDriver();
    }

    [ClassCleanup]
    public static void ClassCleanup()
    {
        _driver?.Quit();
    }

    [TestMethod]
    [DynamicData(nameof(GetSnippetTestCases), DynamicDataSourceType.Method)]
    public void Snippet_ExecutesWithoutError(string propertyName, string snippet, string snippetFile)
    {
        var devicePropertyName = propertyName.Substring(propertyName.IndexOf('.') + 1);
        var renderedJs = RenderSnippetJs(propertyName, snippet);
        var html = BuildTestHtml(propertyName, renderedJs);
        
        // Save HTML beside the .js file
        var htmlFile = snippetFile.Replace(".js", ".html");
        File.WriteAllText(htmlFile, html);
        Console.WriteLine($"[{propertyName}] HTML saved to: {htmlFile}");

        RunTestInBrowser(html, propertyName);
    }

    private string RenderSnippetJs(string propertyName, string snippet)
    {
        var devicePropertyName = propertyName.Substring(propertyName.IndexOf('.') + 1);
        var fullObject = new Dictionary<string, object>
        {
            ["device"] = new Dictionary<string, object>
            {
                [devicePropertyName] = snippet
            },
            ["javascriptProperties"] = new List<string> { propertyName }
        };
        var testData = new Dictionary<string, object>
        {
            ["_jsonObject"] = Newtonsoft.Json.JsonConvert.SerializeObject(fullObject),
            ["_parameters"] = "{}",
            ["_sessionId"] = "test-session-123",
            ["_objName"] = "fod",
            ["_sequence"] = "0",
            ["_enableCookies"] = false,
            ["_updateEnabled"] = false,
            // Test-only: fail the snippet if a document.cookie assignment
            // survives the session-storage patch (i.e. wasn't converted).
            ["_diagnoseUnconvertedCookies"] = true
        };
        return new StubbleBuilder().Build().Render(_template, testData);
    }

    private string BuildTestHtml(string propertyName, string renderedJs)
    {
        return $@"<!DOCTYPE html>
<html>
<head>
    <title>{propertyName}</title>
    <style>
        body {{ font-family: monospace; padding: 20px; }}
        #status {{ padding: 10px; margin: 10px 0; border-radius: 4px; }}
        .pass {{ background: #d4edda; color: #155724; }}
        .fail {{ background: #f8d7da; color: #721c24; }}
        .pending {{ background: #fff3cd; color: #856404; }}
        #errors {{ color: red; white-space: pre-wrap; }}
        #logs {{ background: #f5f5f5; padding: 10px; white-space: pre-wrap; }}
    </style>
</head>
<body>
    <h1>Snippet Test: {propertyName}</h1>
    <div id=""status"" class=""pending"">Running...</div>
    <div id=""errors""></div>
    <h3>Console Log:</h3>
    <div id=""logs""></div>
    <script>
        let logs = [];
        let origLog = console.log, origErr = console.error;
        console.log = function(...a) {{ logs.push(['LOG', ...a]); origLog.apply(console, a); }};
        console.error = function(...a) {{ logs.push(['ERR', ...a]); origErr.apply(console, a); }};
        window.onerror = function(m, u, l, c) {{ logs.push(['JSERR', m + ' @ ' + l + ':' + c]); return false; }};
        function showResult(ok, errs) {{
            document.getElementById('status').className = ok ? 'pass' : 'fail';
            document.getElementById('status').textContent = ok ? 'PASS' : 'FAIL';
            if (errs && errs.length) document.getElementById('errors').textContent = errs.join('\n');
            document.getElementById('logs').textContent = logs.map(l => l.join(' ')).join('\n');
        }}
        function timeout(ms) {{ return new Promise((_, r) => setTimeout(() => r(new Error('Timeout ' + ms + 'ms')), ms)); }}
    </script>
    <script>
{renderedJs}
    </script>
    <script>
        (async function() {{
            try {{
                await Promise.race([
                    new Promise((res, rej) => {{
                        if (typeof fod === 'undefined') {{ rej(new Error('fod not created')); return; }}
                        fod.complete(function(j) {{
                            let e = (j.errors || []).concat(j.warnings || []);
                            e.length ? rej(new Error(e.join('\n'))) : res(j);
                        }});
                    }}),
                    timeout(1000)
                ]);
                showResult(true);
            }} catch (e) {{ showResult(false, [e.message]); }}
        }})();
    </script>
</body>
</html>";
    }

    private void RunTestInBrowser(string html, string propertyName)
    {
        using var server = new SimpleHttpServer(html);
        _driver.Navigate().GoToUrl($"http://localhost:{server.Port}/");
        
        var statusEl = _driver.FindElement(By.Id("status"));
        var deadline = DateTime.Now.AddSeconds(2);
        while (DateTime.Now < deadline && statusEl.GetAttribute("class") == "pending")
        {
            System.Threading.Thread.Sleep(50);
            statusEl = _driver.FindElement(By.Id("status"));
        }
        
        var statusClass = statusEl.GetAttribute("class");
        var statusText = statusEl.Text;
        string errors = "";
        string logs = "";
        try { errors = _driver.FindElement(By.Id("errors")).Text; } catch { }
        try { logs = _driver.FindElement(By.Id("logs")).Text; } catch { }

        Console.WriteLine($"[{propertyName}] Status: {statusText}");
        if (!string.IsNullOrEmpty(logs)) Console.WriteLine($"[{propertyName}] Logs:\n{logs}");

        var browserLogs = _driver.Manage().Logs.GetLog(LogType.Browser);
        var jsErrors = browserLogs.Where(l => l.Level == LogLevel.Severe)
                                  .Select(l => l.Message)
                                  .Where(m => !m.Contains("net::ERR"))
                                  .ToList();

        if (statusClass == "fail")
            Assert.Fail($"{propertyName} failed.\nPage: {errors}\nBrowser: {string.Join("\n", jsErrors)}");
        if (jsErrors.Any())
            Assert.Fail($"{propertyName} browser errors:\n" + string.Join("\n", jsErrors));
    }

    public static IEnumerable<object[]> GetSnippetTestCases()
    {
        var baseDir = _baseDir ?? FindBaseDirectory();
        var snippetsDir = Path.Combine(baseDir, "snippets");

        foreach (var file in Directory.GetFiles(snippetsDir, "*.js"))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            var propertyName = ConvertToPropertyName(name);
            var snippet = File.ReadAllText(file);
            yield return new object[] { propertyName, snippet, file };
        }
    }

    private static string FindBaseDirectory()
    {
        var dir = Directory.GetCurrentDirectory();
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir, "JavaScriptResource.mustache")))
                return dir;
            dir = Directory.GetParent(dir)?.FullName;
        }
        throw new InvalidOperationException("Could not find repository root");
    }

    private static ChromeDriver CreateDriver()
    {
        var options = new ChromeOptions();
        options.AddArgument("--headless");
        options.AddArgument("--no-sandbox");
        options.AddArgument("--disable-dev-shm-usage");
        options.AddArgument("--disable-gpu");
        
        var driver = new ChromeDriver(options);
        driver.Manage().Timeouts().PageLoad = TimeSpan.FromSeconds(30);
        return driver;
    }

    private static string ConvertToPropertyName(string fileName)
    {
        var name = fileName;
        if (name.Contains('_'))
            name = name.Substring(0, name.LastIndexOf('_'));
        return $"device.{name}";
    }
}

class SimpleHttpServer : IDisposable
{
    private readonly HttpListener _listener;
    private readonly Thread _thread;
    private readonly string _content;
    private bool _running;

    public int Port { get; }

    public SimpleHttpServer(string content)
    {
        _content = content;
        _listener = new HttpListener();
        
        for (int port = 8765; port < 9000; port++)
        {
            try
            {
                _listener.Prefixes.Add($"http://localhost:{port}/");
                _listener.Start();
                Port = port;
                break;
            }
            catch { }
        }

        _running = true;
        _thread = new Thread(() =>
        {
            while (_running)
            {
                try
                {
                    var ctx = _listener.GetContext();
                    var bytes = System.Text.Encoding.UTF8.GetBytes(_content);
                    ctx.Response.ContentType = "text/html";
                    ctx.Response.ContentLength64 = bytes.Length;
                    ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                    ctx.Response.OutputStream.Close();
                }
                catch { }
            }
        }) { IsBackground = true };
        _thread.Start();
    }

    public void Dispose()
    {
        _running = false;
        try { _listener.Stop(); } catch { }
        try { _listener.Close(); } catch { }
    }
}
