# Design

This document describes the runtime design and safety boundaries of
`local-env-switch`. See the [README](./README.md) for installation and usage.

## Goals

- Keep project-specific environment names and key policy in host configuration.
- Produce one deterministic generated `.env` from explicit inputs.
- Prevent personal overrides and inherited shell values from replacing protected
  settings silently.
- Make local Redis the default mode and require an explicit opt-out for shared
  Redis.
- Replace the generated `.env` atomically and never print secret values.

The package is not a general secret store, process supervisor, Redis server, or
shell environment loader. It delegates secret retrieval to the Infisical CLI
unless the programmatic caller supplies a `secrets` object.

## Layered architecture

```mermaid
graph TB
  subgraph Consumers["Consumers"]
    direction LR
    Scripts["Host scripts"]
    Library["Node.js callers"]
  end

  subgraph Interfaces["Package interfaces"]
    direction LR
    CLI["CLI adapter"]
    API["Public API"]
  end

  subgraph Core["Application and domain core"]
    direction LR
    Compose["Environment composer"]
    Inspect["Policy inspector"]
    Codec["Dotenv codec"]
  end

  subgraph Adapters["Infrastructure adapters"]
    direction LR
    Resolve["Config resolver"]
    Provider["Infisical adapter"]
    Files["Filesystem adapter"]
  end

  subgraph External["Host and external systems"]
    direction LR
    Config["JSON config and project metadata"]
    Infisical["Infisical CLI"]
    LocalFiles[".env.local, runtime ID, generated .env"]
    Shell["Inherited process environment"]
  end

  Scripts --> CLI
  Library --> API
  CLI --> API
  API --> Resolve
  API --> Provider
  API --> Compose
  API --> Inspect
  API --> Codec
  API --> Files
  Resolve --> Config
  Provider --> Infisical
  Files --> LocalFiles
  Inspect --> Shell
  Compose --> Codec
  Inspect --> Codec
```

The public API owns orchestration. Composition, inspection, and dotenv handling
form the domain core; adapters contain configuration discovery, the external
CLI, and file operations.

## Safety and policy architecture

```mermaid
graph LR
  subgraph Inputs["Host-controlled and external inputs"]
    direction TB
    HostPolicy["Host policy configuration"]
    SecretInput["Provider or supplied secrets"]
    Overlay["Personal .env.local"]
    Ambient["Inherited shell values"]
  end

  subgraph Validation["Validation boundary"]
    direction TB
    ConfigCheck["Config normalization"]
    ProviderCheck["Secret entry validation"]
    DotenvCheck["Portable dotenv parsing"]
  end

  subgraph Enforcement["Policy enforcement"]
    direction TB
    Ownership["Protected and mode-owned keys"]
    Mode["Local or shared mode policy"]
    Encoding["Portable dotenv serialization"]
    Drift["Generated policy and conflict inspection"]
  end

  subgraph Persistence["Private persistence boundary"]
    direction TB
    Runtime["Private runtime ID"]
    Temporary["Temporary file, mode 0600"]
    Generated["Generated .env"]
  end

  HostPolicy --> ConfigCheck
  SecretInput --> ProviderCheck
  Overlay --> DotenvCheck
  Ambient --> Drift
  ConfigCheck --> Ownership
  ConfigCheck --> Mode
  ProviderCheck --> Mode
  DotenvCheck --> Ownership
  Ownership --> Mode
  Runtime --> Mode
  Mode --> Encoding
  Encoding --> Drift
  Drift --> Temporary
  Temporary -->|"atomic rename"| Generated
```

The package enforces four external boundaries:

- JSON configuration resolved by `resolveConfig` is normalized and checked for
  invalid keys, patterns, environment references, URLs, duplicates, and
  file-path collisions. The internal JSON reader is not part of the package
  facade; `resolveConfig` owns the public validation contract.
- Infisical output must be a non-empty JSON array of unique string key/value
  entries with portable environment key names. Programmatically supplied secret
  maps are runtime-checked for string values before any file or network access.
- `.env.local` is parsed before secret retrieval and cannot contain protected or
  mode-owned keys.
- inherited process values are compared by key name; errors report names only.

The merge order is:

```text
preset < secrets < .env.local < selected mode policy
```

Mode policy is authoritative. In local mode it removes configured literal key
prefixes, forces every configured Redis key to the local URL, then applies local
overrides. In shared mode it applies only shared overrides.

## Environment switch sequence

```mermaid
sequenceDiagram
  actor Caller
  participant API
  participant Config
  participant Files
  participant Infisical
  participant Policy

  Caller->>API: use environment with optional secrets
  API->>Config: Resolve and validate configuration
  Config-->>API: Resolved policy and paths
  API->>Files: Read optional .env.local
  Files-->>API: Overlay or missing

  alt Supplied secrets
    API->>Policy: Use supplied secret map
  else Infisical export
    API->>Infisical: Export JSON for environment
    Infisical-->>API: Validated key and value entries
  end

  opt Local policy needs a runtime ID
    API->>Files: Get or create private runtime ID
    Files-->>API: Stable runtime ID
  end

  API->>Policy: Merge, apply mode, serialize, and inspect
  alt Policy or shell violation
    Policy-->>API: Rejected key names
    API-->>Caller: Throw and preserve existing .env
  else Valid generated environment
    Policy-->>API: Serialized dotenv
    API->>Files: Write private temporary file and rename
    Files-->>API: Generated .env replaced
    API-->>Caller: Environment, mode, and generated path
  end
```

`useEnvironment()` returns only switch metadata. Secret values stay inside the
orchestration boundary; callers that explicitly use lower-level composition or
provider helpers remain responsible for not logging or persisting them.

## Guard sequence

The guard is designed to run immediately before a development process or local
worker starts.

```mermaid
sequenceDiagram
  actor Host
  participant Guard
  participant Config
  participant Files
  participant Inspector
  participant App

  Host->>Guard: Run guard with optional runner mode
  Guard->>Config: Resolve current policy
  Config-->>Guard: Resolved policy and paths
  Guard->>Files: Read .env, .env.local, and runtime ID
  Files-->>Guard: Current file contents
  Guard->>Inspector: Compare header, values, policy, and shell

  alt Invalid generated header or dotenv
    Inspector-->>Guard: Parsing error
    Guard-->>Host: Exit 1
  else Protected local or inherited conflict
    Inspector-->>Guard: Conflicting key names
    Guard-->>Host: Exit 1
  else Generated policy drift
    Inspector-->>Guard: Violated key names
    Guard-->>Host: Exit 1
  else Runner uses shared Redis
    Inspector-->>Guard: Runner blocked
    Guard-->>Host: Exit 1
  else Safe to start
    Inspector-->>Guard: Safe status
    Guard-->>Host: Exit 0
    Host->>App: Start process
  end
```

## Invariants and failure behavior

- The first two generated lines bind the file to `toolName`, environment, and
  Redis mode. A missing or edited header is rejected.
- Required keys are checked after all overlays and mode policy are applied.
- Keys owned by either mode, local Redis, or local deletion prefixes are
  protected automatically.
- A local runner is rejected while shared Redis mode is active.
- A failed export, parse, policy check, or serialization does not replace the
  existing generated `.env`.
- The runtime ID is stored separately and may be created before a later switch
  check fails; it contains no secret.
- Atomic rename prevents partial `.env` reads. Concurrent switches are not
  serialized: if two valid switches run at the same time, the last rename wins.
- Parent directories for configured file paths must already exist.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `config` | Discover, normalize, and validate host JSON configuration. |
| `infisical` | Run the external CLI and validate its JSON boundary. |
| `compose` | Merge values, apply mode policy, and inspect drift/conflicts. |
| `dotenv` | Parse and serialize the supported portable dotenv subset. |
| `files` | Read optional files, manage runtime IDs, and replace `.env` atomically. |
| `api` | Orchestrate switch, status, and guard operations. |
| `cli` | Parse commands, render safe messages, and set process exit status. |
