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

## Public object contract

The generated script creates a global object (default name `fod`, set by the
JavaScriptBuilderElement `ObjectName` option). Besides the existing
`complete(callback)` / `onChange(callback)` API the object exposes:

- `isComplete` - `false` while evidence collection is in flight, `true` once
  processing finished (successfully or not; see `data.errors`).
- `data` - the latest raw JSON payload. Unlike the property getters it keeps
  missing values as `null` instead of substituting the null-reason text.

Top-level payload keys are mirrored onto the object, so response payloads
must not use keys named `data`, `isComplete`, `complete`, `onChange`,
`promise` or `sessionId`.

## Page-supplied evidence

A page can pass extra evidence for the JSON refresh request by defining a
plain string-to-string object named `<ObjectName>Evidence` (default
`fodEvidence`) before the script executes:

    <script>
      window.fodEvidence = { 'id.email': 'user@example.com' };
    </script>
    <script src=".../resource.js?id.usage=personalized"></script>

Each entry is url-encoded and appended to the form-data body of the POST
request. The values are never written to the URL, cookies or web storage, so
this is the supported way to pass sensitive evidence such as `id.email`.
Query-string parameters of the script URL override same-named form fields on
the server, so do not duplicate keys across both. The values are sent only
when the script makes its JSON refresh request; with updates disabled or a
cached response there is no request to carry them. Avoid keys that clash
with the request's own fields, such as `session-id` or `sequence`.

## Shipping / Deployment

This repo is not a stand-alone package, but is shipped as part of and used by each of the following repositories / packages:
- [pipeline-dotnet](https://github.com/51Degrees/pipeline-dotnet) as a submodule
- [pipeline-java](https://github.com/51Degrees/pipeline-java) as a submodule
- [pipeline-node](https://github.com/51Degrees/pipeline-node) as a submodule
- [pipeline-python](https://github.com/51Degrees/pipeline-python) as a submodule
- [pipeline-php-core](https://github.com/51Degrees/pipeline-php-core) as a static dependency

Wherever it is a submodule it will be updated by `Nightly Submodule Update` action, wherever it is a static dependency it will be updated by the `Nightly Package Update` action within a target repository.

No special action is needed from the user to deploy the template, just be aware that any changes introduced in this repo will automatically propagate and affect the above packages. 
