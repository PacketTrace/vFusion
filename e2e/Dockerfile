# Pinned to match @playwright/test in package.json. A mismatch between
# the image's browsers and the test runner is a confusing failure mode:
# it reports a missing executable rather than a version problem.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /e2e

COPY package.json package-lock.json ./
# ci, not install: the point of a test image is that it is the same
# every time it is built.
RUN npm ci --no-audit --no-fund

# The bundled Chromium cannot decode H.264, which is what the live view
# streams. Google Chrome can. See the note in playwright.config.ts.
RUN npx playwright install chrome

COPY . .

CMD ["npx", "playwright", "test"]
