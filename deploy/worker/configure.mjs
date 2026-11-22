// Generates only non-secret binding metadata. The initial upload has no public routes.
import { readFileSync, writeFileSync } from 'node:fs'
const [account, service, access] = process.argv.slice(2)
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(account ?? '') ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(service ?? '') ||
    (access !== undefined && !['--access-setup', '--private-pilot'].includes(access)) || process.argv.length > 5) {
  throw Error('Usage: node configure.mjs ACCOUNT_SUBDOMAIN VPC_SERVICE_UUID [--access-setup | --private-pilot]')
}
const config = JSON.parse(readFileSync(new URL('wrangler.json', import.meta.url)))
config.vars.PLAYER_ORIGIN = 'https://' + config.name + '.' + account + '.workers.dev'
if (access !== '--access-setup') config.vpc_services = [{ binding: 'CONTROLLER', service_id: service }]
config.workers_dev = access !== undefined
writeFileSync(new URL('wrangler.private.json', import.meta.url), JSON.stringify(config, null, 2) + '\n')
console.log('OAuth callback: ' + config.vars.PLAYER_ORIGIN + '/api/discord/callback')
