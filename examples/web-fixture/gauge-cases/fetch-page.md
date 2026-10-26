---
criteria:
  - name: Fetch a webpage over verified HTTPS
    rubric: The agent fetches https://example.com/ from its terminal with certificate verification enabled, saves the response body and headers, and reports the title and a short excerpt from the actual response.
config:
  agents:
    - agent: CODEX_CLI
  sampleCount: 1
  inputs: [example-site]
---
Fetch https://example.com/ using curl in your terminal. Keep TLS certificate
verification enabled. Save the response body as page.html and the response
headers as response-headers.txt in your current working directory.

Then report the URL you requested, the HTTP status, the page title, and a short
excerpt from the response. Use the fetched content rather than web search or
prior knowledge. Do not build an application or fetch other pages.
