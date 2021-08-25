import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Exchange, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedClearingHouseFixture, mockedTokenTo } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])

    let exchange: Exchange
    let clearingHouse: MockContract
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let pool: MockContract

    beforeEach(async () => {})

    describe("admin setter")
    describe("swap")
    describe("addLiquidity")
    describe("removeLiquidity")
    describe("updateLastFundingGrowth")
    describe("isOverPriceLimit")
})
