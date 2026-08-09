# Persist explicit client version policies

Client version enforcement is stored as one dedicated policy row per recognized Client Type, while
the existing system setting remains only a global suspension switch. This replaces the implicit
latest-observed fallback with auditable policy modes and durable monotonic baseline history; a
missing row deliberately means no enforcement, and a one-time initialization preserves the old
automatic behavior only for client types active when an enabled installation is upgraded or first
enabled.
