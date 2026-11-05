FROM eclipse-temurin:25-jdk-noble@sha256:95e350ad1eb738f943e141640f7e3d797e483359a3b33c3864255bfd1ad71f8a
ENV DEBIAN_FRONTEND=noninteractive MAVEN_OPTS="-Xmx128m" LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends python3 xvfb x11vnc fonts-noto-cjk libxi6 libxtst6 libxrender1 fontconfig ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz -o /tmp/maven.tar.gz && \
    curl --fail --location --retry 3 https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz.sha512 -o /tmp/maven.sha512 && \
    echo "$(cat /tmp/maven.sha512)  /tmp/maven.tar.gz" | sha512sum -c - && \
    tar -xzf /tmp/maven.tar.gz -C /opt && rm /tmp/maven.tar.gz /tmp/maven.sha512
ENV PATH="/opt/apache-maven-3.9.11/bin:${PATH}"
ARG JDTLS_ARCHIVE=jdt-language-server-1.56.0-202601291528.tar.gz
RUN mkdir -p /opt/jdtls /opt/m2 /opt/acceptance /opt/runner && \
    curl --fail --location --retry 3 "https://download.eclipse.org/jdtls/milestones/1.56.0/${JDTLS_ARCHIVE}" -o /tmp/jdtls.tar.gz && \
    curl --fail --location --retry 3 "https://download.eclipse.org/jdtls/milestones/1.56.0/${JDTLS_ARCHIVE}.sha256" -o /tmp/jdtls.sha256 && \
    echo "$(cut -d' ' -f1 /tmp/jdtls.sha256)  /tmp/jdtls.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && rm /tmp/jdtls.tar.gz /tmp/jdtls.sha256 && \
    curl --fail --location --retry 3 https://repo.maven.apache.org/maven2/org/junit/platform/junit-platform-console-standalone/1.13.4/junit-platform-console-standalone-1.13.4.jar -o /opt/junit-console.jar
COPY seed/ /opt/template/
RUN cd /opt/template && mvn -B --no-transfer-progress -Dmaven.repo.local=/opt/m2 test && \
    cp -a test/. /opt/acceptance/ && rm -rf target && chmod -R a+rX /opt
COPY runner.py /opt/runner/runner.py
COPY StudioLauncher.java /opt/runner/StudioLauncher.java
RUN javac -d /opt/runner /opt/runner/StudioLauncher.java && chmod -R a+rX /opt/runner
WORKDIR /tmp
