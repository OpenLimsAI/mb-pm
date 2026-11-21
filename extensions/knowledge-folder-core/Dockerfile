ARG CORE_BASE=dikw-core:0.6.10
FROM scratch AS security_packages
# Debian 13 security archive (amd64) and the certifi wheel published on PyPI.
ADD --checksum=sha256:15c2030e0fb46580af4f1b4cc303f4bd26da781b004e99763bc9eff7cf8e19b8 https://deb.debian.org/debian-security/pool/updates/main/a/apt/apt_3.0.4_amd64.deb /packages/apt.deb
ADD --checksum=sha256:577eb8f489de419290102364892dbd13ca256297b61f96d61b114fd4ac18be41 https://deb.debian.org/debian-security/pool/updates/main/a/apt/libapt-pkg7.0_3.0.4_amd64.deb /packages/libapt.deb
ADD --checksum=sha256:8c27c342230503b73dfde629642c3b352e87b554e06d60cf58772f236a305ceb https://deb.debian.org/debian-security/pool/updates/main/z/zlib/zlib1g_1.3.dfsg+really1.3.1-1+deb13u1_amd64.deb /packages/zlib.deb
ADD --checksum=sha256:73191c47aaa79da394e8fee2dbc2ec827432cab56311122c9e47abf79e390f62 https://files.pythonhosted.org/packages/08/ba/95dd616042484f7c83a06974388b37b837732740ee70bc5dc715b5fcd55a/certifi-2026.10.18-py3-none-any.whl /packages/certifi-2026.10.18-py3-none-any.whl

FROM ${CORE_BASE}
USER root
# Use the pip wheel already bundled with CPython. Neither the temporary
# installer nor the four input archives become additional runtime dependencies.
RUN --network=none --mount=from=security_packages,source=/packages,target=/packages \
    dpkg -i /packages/libapt.deb /packages/apt.deb /packages/zlib.deb \
    && dpkg --audit \
    && pip_wheel="$(python -c 'from pathlib import Path; import ensurepip; print(next((Path(ensurepip.__file__).parent / "_bundled").glob("pip-*.whl")))')" \
    && PYTHONPATH="$pip_wheel" python -m pip --isolated install --disable-pip-version-check --no-index --no-deps --no-cache-dir /packages/certifi-2026.10.18-py3-none-any.whl \
    && python -c 'import certifi, ssl; assert certifi.__version__ == "2026.10.18"; ssl.create_default_context(cafile=certifi.where())'
USER dikw

COPY folder_core.py run.py container_entry.py /opt/mberp-folder-import/

# Balance preservation of non-serve CLI commands with the existing container
# contract. The live Compose service uses this same serve argument list.
ENTRYPOINT ["python", "-B", "/opt/mberp-folder-import/container_entry.py"]
CMD ["serve", "--base", "/base", "--host", "0.0.0.0", "--port", "8765"]
