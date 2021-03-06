'use strict'
const pmap = require('p-map')
const URL = require('url').URL
const {
  isTypeExtensionNode,
  isTypeDefinitionNode,
  parse
} = require('graphql')
const { isFirstClassDefinition } = require('./is-first-class-definition')

const { buildRequest, sendRequest } = require('./request')
const SubscriptionClient = require('../subscription-client')
const SubscriptionManager = require('../subscription-manager')

function hasDirective (directiveName, node) {
  return node.directives.some(directive => directive.name.value === directiveName)
}

function createFieldSet (definition, filterFn = () => false) {
  const fieldsSet = new Set()

  if (definition.fields) {
    for (const field of definition.fields) {
      if (!filterFn(field)) {
        fieldsSet.add(field.name.value)
      }
    }
  }

  return fieldsSet
}

function shouldExtendDefinition (definition) {
  return (
    isTypeExtensionNode(definition) ||
    hasDirective('extends', definition) ||
    isFirstClassDefinition(definition)
  )
}

function createTypeMap (schemaDefinition) {
  const parsedSchema = parse(schemaDefinition)
  const typeMap = {}
  const types = new Set()
  const extensionTypeMap = {}

  for (const definition of parsedSchema.definitions) {
    const shouldExtend = shouldExtendDefinition(definition)

    /* istanbul ignore else we are only interested in type definition and type extension scenarios */
    if (isTypeDefinitionNode(definition) && !shouldExtend) {
      typeMap[definition.name.value] = createFieldSet(definition)
      types.add(definition.name.value)
    } else if (shouldExtend) {
      typeMap[definition.name.value] = createFieldSet(definition)
      extensionTypeMap[definition.name.value] = createFieldSet(
        definition,
        hasDirective.bind(null, 'external')
      )

      if (isFirstClassDefinition(definition)) {
        types.add(definition.name.value)
      }
    }
  }

  return { typeMap, types, extensionTypeMap }
}

async function buildServiceMap (services) {
  const serviceMap = {}

  for (const service of services) {
    const { name, ...opts } = service
    const { request, close } = buildRequest(opts)
    const url = new URL(opts.url)

    const serviceConfig = {
      sendRequest: sendRequest(request, url),
      close,
      async init () {
        const response = await serviceConfig.sendRequest({
          body: JSON.stringify({
            query: `
            query ServiceInfo {
              _service {
                sdl
              }
            }
            `
          })
        })

        const schemaDefinition = response.json.data._service.sdl

        const { typeMap, types, extensionTypeMap } = createTypeMap(schemaDefinition)

        return {
          schemaDefinition,
          typeMap,
          types,
          extensionTypeMap
        }
      }
    }

    if (service.wsUrl) {
      const manager = new SubscriptionManager(service.wsUrl, {
        serviceName: service.name,
        reconnect: true
      })

      serviceConfig.createSubscription = manager.createSubscription.bind(manager)
    }

    serviceMap[service.name] = serviceConfig
  }

  const mapper = async service => {
    const { schemaDefinition, typeMap, types, extensionTypeMap } = await serviceMap[service.name].init()
    serviceMap[service.name].schemaDefinition = schemaDefinition
    serviceMap[service.name].typeMap = typeMap
    serviceMap[service.name].types = types
    serviceMap[service.name].extensionTypeMap = extensionTypeMap
    serviceMap[service.name].name = service.name
  }

  await pmap(services, mapper, { concurrency: 8 })

  return serviceMap
}

module.exports = buildServiceMap
