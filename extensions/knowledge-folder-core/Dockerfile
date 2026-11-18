ARG CORE_BASE=dikw-core:0.6.10
FROM ${CORE_BASE}

COPY folder_core.py run.py container_entry.py /opt/mberp-folder-import/

# Balance preservation of non-serve CLI commands with the existing container
# contract. The live Compose service uses this same serve argument list.
ENTRYPOINT ["python", "-B", "/opt/mberp-folder-import/container_entry.py"]
CMD ["serve", "--base", "/base", "--host", "0.0.0.0", "--port", "8765"]
