#!/bin/bash
set -e

WORKER_IPS=("3.86.185.94" "35.173.247.200" "52.87.99.91")
KEY_PATH="/Users/gursimranbhullar/.ssh/relay-cluster-key.pem"

for IP in "${WORKER_IPS[@]}"; do
    echo "--------------------------------------------------"
    echo "Updating Worker: $IP"
    echo "--------------------------------------------------"
    
    ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no ubuntu@$IP << 'EOF'
        set -e
        # Fetch Secret
        export WS_SECRET=$(aws ssm get-parameter --name "/relay/ws_secret" --region "us-east-1" --with-decryption --query "Parameter.Value" --output text)
        
        echo "Pulling latest code..."
        cd /opt/relay-cluster
        sudo git pull
        
        echo "Rebuilding Worker..."
        cd worker
        sudo docker build -t relay-worker .
        
        echo "Restarting Container..."
        # We need to find the existing container ID or name to restart it properly
        # Or just stop/rm and run a new one if we had the run command.
        # Since we don't want to lose the env vars passed in user_data, 
        # we will try 'docker restart' if the container exists but is stopped.
        # If it was never created (build failed), we need the run command.
        
        # Check if container exists
        if sudo docker ps -a --format '{{.Names}}' | grep -q "^relay-worker$"; then
            echo "Container exists, restarting..."
            sudo docker restart relay-worker
        else
            echo "Container does not exist! Attempting to run from scratch..."
            # We need to reconstruct the run command. This is tricky without the env vars.
            # Let's try to extract them from user-data.log or just fail and ask for help.
            # Actually, user_data_worker.sh puts the run command in the history/logs.
            
            # BETTER APPROACH: The container likely exists but is in 'Exited' state due to build failure?
            # No, if build failed, 'docker run' might have failed if it was 'docker build && docker run'.
            # Looking at user_data_worker.sh:
            # docker build -t relay-worker .
            # docker run ...
            # If build failed, run was likely never executed.
            
            # Let's try to grab the run command from the user_data script on the machine
            # It's in /var/lib/cloud/instance/scripts/part-001 usually
            
            RUN_CMD=$(sudo grep -A 20 "docker run -d" /var/lib/cloud/instance/scripts/part-001 | head -n 16)
            # Fix invalid cap-add syntax (comma separated to multiple flags)
            RUN_CMD=${RUN_CMD//--cap-add=CHOWN,SETUID,SETGID/--cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID}
            echo "Found run command:"
            echo "$RUN_CMD"
            eval "sudo $RUN_CMD"
        fi
        
        echo "Worker $IP updated successfully!"
EOF
done

echo "All workers updated."
