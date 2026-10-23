package protocol

// JoinPath is the control-plane endpoint a node POSTs a [JoinRequest] to.
const JoinPath = "/v1/nodes/join"

// JoinRequest is the body of POST /v1/nodes/join.
type JoinRequest struct {
	// Token is the single-use join token shown in the dashboard.
	Token string `json:"token"`
	// Name is the display name, 1–63 characters; agents default it to the
	// hostname.
	Name         string `json:"name"`
	Hostname     string `json:"hostname"`
	AgentVersion string `json:"agent_version"`
	OS           string `json:"os"`
	Arch         Arch   `json:"arch"`
	// PublicKey is the agent's Ed25519 identity public key, standard base64
	// of the raw 32 bytes.
	PublicKey string `json:"public_key"`
	// EncryptionPublicKey is the agent's X25519 public key, standard base64
	// of the raw 32 bytes, separate from the identity key. Variables and
	// build secrets are sealed to it.
	EncryptionPublicKey string       `json:"encryption_public_key,omitempty"`
	PublicIP            *string      `json:"public_ip"`
	Hardware            Hardware     `json:"hardware"`
	Capabilities        Capabilities `json:"capabilities"`
}

// JoinResponse is the 201 response of POST /v1/nodes/join.
type JoinResponse struct {
	NodeID string `json:"node_id"`
	// Credential is the long-lived bearer credential for the connect endpoint.
	// The control plane returns it exactly once.
	Credential string `json:"credential"`
	// ControlPublicKey is the control plane's Ed25519 public key, standard
	// base64 of the raw 32 bytes. Agents pin it to verify every envelope.
	ControlPublicKey string `json:"control_public_key"`
	// ConnectURL is the absolute wss:// URL to dial.
	ConnectURL string `json:"connect_url"`
}

// ErrorResponse is the body of every 4xx response from the control plane's
// HTTP API.
type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail describes why a control-plane request failed.
type ErrorDetail struct {
	// Code is a stable, machine-readable identifier such as "token_expired".
	Code string `json:"code"`
	// Message is a human-readable explanation.
	Message string `json:"message"`
}
