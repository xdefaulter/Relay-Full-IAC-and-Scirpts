output "manager_ip" {
  value = aws_instance.manager.public_ip
}

output "worker_ips" {
  value = [for w in aws_instance.worker : w.public_ip]
}
