'use strict'

const WebSocket = require('ws')
const errorHack = require('./gateway/lifehack')
const {
  GQL_CONNECTION_INIT,
  GQL_CONNECTION_ACK,
  GQL_START,
  GQL_DATA,
  GQL_COMPLETE,
  GQL_STOP,
  GRAPHQL_WS
} = require('./subscription-protocol')
const HEARTBEAT_INTERVAL = 20 * 1000

function heartbeat (socket) {
  if (!socket) {
    return;
  }
  socket.isAlive = true
}

class SubscriptionClient {
  constructor (uri, config) {
    this.uri = uri
    this.socket = null
    // this.operationId = 0
    this.ready = false
    this.operations = new Map()
    // this.operationsCount = {}
    // this.subscriptionQueryMap = {}
    const {
      protocols = [],
      reconnect,
      maxReconnectAttempts = Infinity,
      serviceName,
      connectionCallback,
      failedReconnectCallback
    } = config

    this.protocols = [GRAPHQL_WS, ...protocols]
    this.tryReconnect = reconnect
    this.maxReconnectAttempts = maxReconnectAttempts
    this.serviceName = serviceName
    this.reconnectAttempts = 0
    this.connectionCallback = connectionCallback
    this.failedReconnectCallback = failedReconnectCallback

    // this.connect()
    errorHack.on('reconnect', () => {
      setImmediate(() => {
        this.close(true, false);
      })
    })
  }

  createConnection() {
    this.socket = new WebSocket(this.uri, this.protocols);

    return new Promise((resolve, reject) => {
      this.socket.onopen = () => {
        resolve();
      };

      this.socket.onerror = (e) => {
        reject(e);
      };
    });
  }

      // this.socket = new WebSocket(this.uri, this.protocols)



    // this.socket.onopen = () => {
    //   /* istanbul ignore else */
    //   if (this.socket && this.socket.readyState === WebSocket.OPEN) {
    //     this.sendMessage(null, GQL_CONNECTION_INIT)
    //   }

    //   if (!this.socket) {
    //     return;
    //   }


    //   this.socket.isAlive = true

    //   // const keepaliveInterval = setInterval(() => {
    //   //   if (!this.socket) {
    //   //     clearInterval(keepaliveInterval)
    //   //     return
    //   //   }
    //   //   if (!this.socket || !this.socket.isAlive) {
    //   //     this.close(true, false)
    //   //     return
    //   //   }
    //   //   this.socket.isAlive = false
    //   //   this.socket.ping(null, false)
    //   // }, HEARTBEAT_INTERVAL).unref()
    // }

  async connect () {
    await this.createConnection();

    this.sendMessage(null, GQL_CONNECTION_INIT);

    // this.socket.on('pong', () => {
    //   console.log("SOCKET PONG");
    //   // heartbeat(this.socket)
    // })

    // this.socket.on('ping', () => {
    //   console.log("SOCKET PING");
    // });

    this.socket.onclose = () => {
      if (!this.closedByUser) {
        this.close(this.tryReconnect, false)
      }
    }

    this.socket.onerror = (e) => {
      throw e;
    }

    this.socket.onmessage = ({ data }) => {
      this.handleMessage(data);
    }
  }

  close (tryReconnect, closedByUser = true) {
    this.closedByUser = closedByUser
    this.isReady = false

    if (this.socket !== null) {
      if (closedByUser) {
        this.unsubscribeAll()
      }

      this.socket.close()
      this.socket = null
      this.reconnecting = false

      if (tryReconnect) {
        for (const operationId of this.operations.keys()) {
          const { options, handler } = this.operations.get(operationId)

          this.operations.set(operationId, {
            options,
            handler,
            started: false
          })
        }

        this.reconnect()
      }
    }
  }

  getReconnectDelay () {
    const delayMs = 100 * Math.pow(2, this.reconnectAttempts)

    return Math.min(delayMs, 10000)
  }

  reconnect () {
    if (
      this.reconnecting ||
      this.reconnectAttempts > this.maxReconnectAttempts
    ) {
      return this.failedReconnectCallback && this.failedReconnectCallback()
    }

    this.reconnectAttempts++
    this.reconnecting = true

    const delay = this.getReconnectDelay()

    this.reconnectTimeoutId = setTimeout(() => {
      this.connect()
    }, delay)
  }

  unsubscribe (operationId, forceUnsubscribe) {
    if (this.operations.get(operationId) || forceUnsubscribe) {
      this.sendMessage(operationId, GQL_STOP, null);
    }
  }

  unsubscribeAll () {
    for (const operationId of this.operations.keys()) {
      this.unsubscribe(operationId, true)
    }
  }

  sendMessage (operationId, type, payload) {
    try {
      this.socket.send(
        JSON.stringify({
          id: operationId,
          type,
          payload
        })
      )
    } catch (err) {
      this.close(true, false)
    }
  }

  handleMessage (message) {
    let data
    let operationId
    let operation

    try {
      data = JSON.parse(message)
      operationId = data.id
    } catch (e) {
      /* istanbul ignore next */
      throw new Error(
        `Invalid message received: "${message}" Message must be JSON parsable.`
      )
    }

    if (operationId) {
      operation = this.operations.get(operationId)
    }

    switch (data.type) {
      case GQL_CONNECTION_ACK:
        this.reconnecting = false
        this.ready = true
        this.reconnectAttempts = 0

        for (const operationId of this.operations.keys()) {
          this.startOperation(operationId)
        }

        if (this.connectionCallback) {
          this.connectionCallback()
        }

        break
      case GQL_DATA:
        /* istanbul ignore else */
        if (operation) {
          operation.handler(data.payload.data)
        }
        break
      case GQL_COMPLETE:
        /* istanbul ignore else */
        if (operation) {
          operation.handler(null)
          this.operations.delete(operationId)
        }

        break
      /* istanbul ignore next */
      default:
        /* istanbul ignore next */
        throw new Error(`Invalid message type: "${data.type}"`)
    }
  }

  startOperation (operationId) {
    const { started, options, handler } = this.operations.get(operationId)
    if (this.ready && !started) {
      this.operations.set(operationId, { started: true, options, handler })
      this.sendMessage(operationId, GQL_START, options)
    }
  }

  async createSubscription(query, variables, publish, operationId) {
    if(!this.socket) {
      await this.connect();
    }

    if (this.operations.get(operationId)) {
      return operationId
    }

    this.operations.set(operationId, {
      started: false,
      options: { query, variables },
      handler: async (data) => {
        await publish({
          topic: `${this.serviceName}_${operationId}`,
          payload: data
        })
      }
    })

    this.startOperation(operationId);

    return operationId
  }
}

module.exports = SubscriptionClient
