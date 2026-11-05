# Reuse the installed toolchain for an offline, small incremental deployment.
# The full runner/Dockerfile remains the reproducible clean-machine definition.
FROM xiangqi-runner:0.1.0
RUN rm -rf /opt/template /opt/acceptance && mkdir -p /opt/template /opt/acceptance
COPY seed/ /opt/template/
RUN cd /opt/template && mvn -B --no-transfer-progress -o -Dmaven.repo.local=/opt/m2 test && \
    cp -a test/. /opt/acceptance/ && rm -rf target && chmod -R a+rX /opt
COPY runner.py StudioLauncher.java /opt/runner/
RUN javac -d /opt/runner /opt/runner/StudioLauncher.java && chmod -R a+rX /opt/runner
