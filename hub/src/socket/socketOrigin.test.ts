import { describe, expect, it } from 'vitest'
import { isAllowedSocketOrigin } from './socketOrigin'

const listed = ['http://localhost:3008']

describe('isAllowedSocketOrigin', () => {
    it('lets the hub\'s own page in under any name it was reached by', () => {
        const lan = new Headers({ host: '10.176.37.1:3008' })
        expect(isAllowedSocketOrigin('http://10.176.37.1:3008', lan, listed)).toBe(true)

        const relay = new Headers({ host: 'localhost:3008', 'x-forwarded-host': 'abc.relay.hapi.run' })
        expect(isAllowedSocketOrigin('https://abc.relay.hapi.run', relay, listed)).toBe(true)
    })

    it('turns away other sites unless they are listed', () => {
        const headers = new Headers({ host: '10.176.37.1:3008' })
        expect(isAllowedSocketOrigin('https://evil.example', headers, listed)).toBe(false)
        expect(isAllowedSocketOrigin('http://10.176.37.1:9999', headers, listed)).toBe(false)
        expect(isAllowedSocketOrigin('http://localhost:3008', headers, listed)).toBe(true)
        expect(isAllowedSocketOrigin('https://evil.example', headers, ['*'])).toBe(true)
    })

    it('lets requests without an Origin through', () => {
        expect(isAllowedSocketOrigin(null, new Headers(), listed)).toBe(true)
    })
})
