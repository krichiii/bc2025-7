FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install && npm install -g nodemon

COPY . .

RUN mkdir -p /app/cache

EXPOSE 3000 9229

CMD ["npm", "run", "dev"]
