# Pi Managed Agents API

Architecture proposal for a service that provides durable agent sessions, managed execution, tools, and artifacts using Pi as its harness.

The design starts from the documented behavior of OpenAI Agents API and Claude Managed Agents, then maps those responsibilities to Pi.

- [Provider architecture research](docs/provider-architecture.md) compares the reference products and their operational contracts.
- [Proposed Pi architecture](docs/architecture.md) describes the runtime boundary, resources, persistence, recovery, and implementation stages.

Status: design only. No API server or runtime has been implemented.

Documentation baseline: 13 November 2026. The design uses the Pi coding agent SDK as its harness, with persistence, recovery, and managed execution supplied by the service.
