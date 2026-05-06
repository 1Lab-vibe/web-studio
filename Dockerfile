FROM mcr.microsoft.com/playwright:v1.59.1-noble AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
EXPOSE 8787
CMD ["node", "server/index.js"]
