import {
    ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
    ARBITRUM_RINKEBY_WEB3_ENDPOINT,
    COMPANION_NETWORK,
    OPTIMISM_DEPLOYER_MNEMONIC,
    OPTIMISM_KOVAN_DEPLOYER_MNEMONIC,
    OPTIMISM_KOVAN_WEB3_ENDPOINT,
    OPTIMISM_WEB3_ENDPOINT,
    RINKEBY_DEPLOYER_MNEMONIC,
    RINKEBY_WEB3_ENDPOINT,
} from "../constants"

export function getUrl(network: string) {
    const NetworkUrl = {
        optimism: OPTIMISM_WEB3_ENDPOINT,
        optimismKovan: OPTIMISM_KOVAN_WEB3_ENDPOINT,
        rinkeby: RINKEBY_WEB3_ENDPOINT,
        arbitrumRinkeby: ARBITRUM_RINKEBY_WEB3_ENDPOINT,
    }

    return NetworkUrl[network] ? NetworkUrl[network] : ""
}

export function getMnemonic(network: string) {
    const NetworkMnemonic = {
        optimism: OPTIMISM_DEPLOYER_MNEMONIC,
        optimismKovan: OPTIMISM_KOVAN_DEPLOYER_MNEMONIC,
        rinkeby: RINKEBY_DEPLOYER_MNEMONIC,
        arbitrumRinkeby: ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
    }

    return NetworkMnemonic[network] ? NetworkMnemonic[network] : ""
}

export function hardhatForkConfig() {
    return COMPANION_NETWORK
        ? {
              forking: {
                  enabled: true,
                  url: getUrl(COMPANION_NETWORK),
              },
              accounts: {
                  mnemonic: getMnemonic(COMPANION_NETWORK),
              },
              companionNetworks: {
                  fork: COMPANION_NETWORK,
              },
          }
        : {}
}

export const tenderlyConfig = {
    optimism: "curie-optimism",
    optimismKovan: "curie-optimismkovan",
}
