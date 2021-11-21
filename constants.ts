import _ from "lodash"
export const RINKEBY_DEPLOYER_MNEMONIC = _.defaultTo(`${process.env["RINKEBY_DEPLOYER_MNEMONIC"]}`, "")
export const RINKEBY_WEB3_ENDPOINT = _.defaultTo(`${process.env["RINKEBY_WEB3_ENDPOINT"]}`, "")
export const ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC = _.defaultTo(
    `${process.env["ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC"]}`,
    "",
)
export const ARBITRUM_RINKEBY_WEB3_ENDPOINT = _.defaultTo(`${process.env["ARBITRUM_RINKEBY_WEB3_ENDPOINT"]}`, "")
export const OPTIMISM_KOVAN_WEB3_ENDPOINT = _.defaultTo(`${process.env["OPTIMISM_KOVAN_WEB3_ENDPOINT"]}`, "")
export const OPTIMISM_KOVAN_DEPLOYER_MNEMONIC = _.defaultTo(`${process.env["OPTIMISM_KOVAN_DEPLOYER_MNEMONIC"]}`, "")
export const HARDHAT_FORK_WEB3_ENDPOINT = _.defaultTo(`${process.env["HARDHAT_FORK_WEB3_ENDPOINT"]}`, "")
export const HARDHAT_FORK_DEPLOYER_MNEMONIC = _.defaultTo(`${process.env["HARDHAT_FORK_DEPLOYER_MNEMONIC"]}`, "")
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
if (_.isEmpty(HARDHAT_FORK_WEB3_ENDPOINT)) {
    console.warn("HARDHAT_FORK_WEB3_ENDPOINT is empty")
}
if (_.isEmpty(HARDHAT_FORK_DEPLOYER_MNEMONIC)) {
    console.warn("HARDHAT_FORK_DEPLOYER_MNEMONIC is empty")
}
