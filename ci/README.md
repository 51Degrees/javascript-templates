# CI scripts

These scripts implement the hook contract that the shared
[`common-ci`](https://github.com/51Degrees/common-ci) reusable workflows expect.
`nightly-pull-request.build-and-test.ps1` in `common-ci` clones this repository
and invokes the hooks below, in order, with the matrix entry from
[`options.json`](options.json) splatted in as parameters:

| Hook | Purpose |
| --- | --- |
| `fetch-assets.ps1` | Downloads the Hash data file the snippet tool generates from. |
| `setup-environment.ps1` | Installs the native toolchain (CMake, g++) used to build the snippet tool. |
| `build-project.ps1` | Installs Node deps and builds the C# snippet test project. |
| `run-unit-tests.ps1` | Renders `JavaScriptResource.mustache` and drives it with `node template-tests.js`. |
| `run-integration-tests.ps1` | Clones `device-detection-cxx`, builds `js-snippet-export`, generates `snippets/`, and drives every snippet through the template in a real browser. |

## The snippet pipeline

The template itself is not executable, so coverage comes in two layers:

* **Unit** (`run-unit-tests.ps1`) - fast, window-less checks of the rendered
  script against a fake endpoint. No data file or browser required.
* **Integration** (`run-integration-tests.ps1`) - the producer/consumer chain.
  `device-detection-cxx`'s `js-snippet-export` tool is the *producer* (the
  equivalent of the examples repo that `device-detection-dotnet` clones for its
  integration coverage); the C# `FiftyOne.JavascriptTemplateTests` project is
  the *consumer* that renders and browser-checks each generated snippet.

`snippets/` is a build artifact and is not committed - it is populated afresh by
the integration step on every run.
