variable "region" {
  type    = string
  default = "ca-west-1"
}

variable "ssh_key_name" {
  type = string
}

variable "worker_count" {
  type    = number
  default = 5
}
