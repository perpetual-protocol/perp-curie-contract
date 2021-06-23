import _ from "lodash"
export const RINKEBY_DEPLOYER_MNEMONIC = _.defaultTo(`${process.env["RINKEBY_DEPLOYER_MNEMONIC"]}`, "")
export const RINKEBY_WEB3_ENDPOINT = _.defaultTo(`${process.env["RINKEBY_WEB3_ENDPOINT"]}`, "")

if (_.isEmpty(RINKEBY_DEPLOYER_MNEMONIC)) {
    console.warn("RINKEBY_MNEMONIC is empty")
}
if (_.isEmpty(RINKEBY_WEB3_ENDPOINT)) {
    console.warn("RINKEBY_WEB3_ENDPOINT is empty")
}
