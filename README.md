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

## Shipping / Deployment

This repo is not a stand-alone package, but is shipped as part of and used by each of the following repositories / packages:
- [pipeline-dotnet](https://github.com/51Degrees/pipeline-dotnet) as a submodule
- [pipeline-java](https://github.com/51Degrees/pipeline-java) as a submodule
- [pipeline-node](https://github.com/51Degrees/pipeline-node) as a submodule
- [pipeline-python](https://github.com/51Degrees/pipeline-python) as a submodule
- [pipeline-php-core](https://github.com/51Degrees/pipeline-php-core) as a static dependency

Wherever it is a submodule it will be updated by `Nightly Submodule Update` action, wherever it is a static dependency it will be updated by the `Nightly Package Update` action within a target repository.

No special action is needed from the user to deploy the template, just be aware that any changes introduced in this repo will automatically propagate and affect the above packages. 
