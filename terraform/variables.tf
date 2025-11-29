variable "region" {
  type        = string
  default     = "ca-west-1"
  description = "AWS region for deployment"
}

variable "ssh_key_name" {
  type        = string
  description = "Name of SSH key pair in AWS for instance access"
}

variable "worker_count" {
  type        = number
  default     = 3
  description = "Number of worker instances to create"
}

variable "environment" {
  type        = string
  default     = "production"
  description = "Environment name for tagging (e.g., production, staging, dev)"
}

variable "admin_ssh_cidr" {
  type        = string
  default     = ""
  description = "CIDR block for SSH access to workers (e.g., YOUR_IP/32). Leave empty to disable SSH."
}

variable "ws_authentication_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret for WebSocket authentication between manager and workers"
}

variable "relay_username" {
  type        = string
  default     = ""
  description = "Username for Relay login"
}

variable "relay_password" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Password for Relay login"
}
