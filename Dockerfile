FROM node:18

# Working Dir
WORKDIR /usr/src/app

# Copy Package Json
COPY package.json yarn.lock* ./

# Install Files
RUN yarn install

# Compile typescript
RUN yarn add -D typescript

# Copy Source Files
COPY . .

# Start
EXPOSE 3000

CMD ["yarn", "start"]
