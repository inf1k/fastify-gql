const SubscriptionClient = require('./subscription-client');

class SubscriptionManager {

  constructor(url, config) {
    this.url = url;
    this.config = config;
  }

  async createSubscription(query, context, variables, publish) {
    const connection = context.subscriptionConnection;
    const operationId = context.operationId;

    if(!connection.clients[this.url]) {
      connection.clients[this.url] = new SubscriptionClient(this.url, this.config);
    }

    const client = connection.clients[this.url];

    return client.createSubscription(query, variables, publish, operationId);
  }
}

module.exports = SubscriptionManager;
