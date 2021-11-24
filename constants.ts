import _ from "lodash"
export const RINKEBY_DEPLOYER_MNEMONIC = _.defaultTo(`${process.env["RINKEBY_DEPLOYER_MNEMONIC"]}`, "")
export const RINKEBY_WEB3_ENDPOINT = _.defaultTo(`${process.env["RINKEBY_WEB3_ENDPOINT"]}`, "")
export const ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC = _.defaultTo(
    `${process.env["ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC"]}`,
    "",
)
export const ARBITRUM_RINKEBY_WEB3_ENDPOINT = _.defaultTo(process.env["ARBITRUM_RINKEBY_WEB3_ENDPOINT"], "")
export const OPTIMISM_KOVAN_WEB3_ENDPOINT = _.defaultTo(process.env["OPTIMISM_KOVAN_WEB3_ENDPOINT"], "")
export const OPTIMISM_KOVAN_DEPLOYER_MNEMONIC = _.defaultTo(process.env["OPTIMISM_KOVAN_DEPLOYER_MNEMONIC"], "")
export const OPTIMISM_WEB3_ENDPOINT = _.defaultTo(process.env["OPTIMISM_WEB3_ENDPOINT"], "")
export const OPTIMISM_DEPLOYER_MNEMONIC = _.defaultTo(process.env["OPTIMISM_DEPLOYER_MNEMONIC"], "")
export const COMPANION_NETWORK = _.defaultTo(process.env["COMPANION_NETWORK"], "")
export const ETHERSCAN_API_KEY = _.defaultTo(process.env["ETHERSCAN_API_KEY"], "")

if (_.isEmpty(RINKEBY_DEPLOYER_MNEMONIC)) {
    console.warn("RINKEBY_MNEMONIC is empty")
}
if (_.isEmpty(RINKEBY_WEB3_ENDPOINT)) {
    console.warn("RINKEBY_WEB3_ENDPOINT is empty")
}
if (_.isEmpty(ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC)) {
    console.warn("ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC is empty")
}
if (_.isEmpty(ARBITRUM_RINKEBY_WEB3_ENDPOINT)) {
    console.warn("ARBITRUM_RINKEBY_WEB3_ENDPOINT is empty")
}
if (_.isEmpty(OPTIMISM_KOVAN_DEPLOYER_MNEMONIC)) {
    console.warn("OPTIMISM_KOVAN_DEPLOYER_MNEMONIC is empty")
}
if (_.isEmpty(OPTIMISM_KOVAN_WEB3_ENDPOINT)) {
    console.warn("OPTIMISM_KOVAN_DEPLOYER_MNEMONIC is empty")
}
if (_.isEmpty(OPTIMISM_DEPLOYER_MNEMONIC)) {
    console.warn("OPTIMISM_DEPLOYER_MNEMONIC is empty")
}
if (_.isEmpty(OPTIMISM_WEB3_ENDPOINT)) {
    console.warn("OPTIMISM_WEB3_ENDPOINT is empty")
}
if (_.isEmpty(COMPANION_NETWORK)) {
    console.warn("COMPANION_NETWORK is empty")
}
if (_.isEmpty(ETHERSCAN_API_KEY)) {
    console.warn("ETHERSCAN_API_KEY is empty")
}
