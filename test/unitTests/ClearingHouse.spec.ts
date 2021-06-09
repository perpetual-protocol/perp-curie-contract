import { ClearingHouse, TestERC20 } from "../../typechain"
import { ethers, waffle } from "hardhat"

import { BigNumber } from "@ethersproject/bignumber"
import { MockContract } from "@eth-optimism/smock"
import { clearingHouseFixture } from "../shared/fixturesUT"
import { expect } from "chai"

describe("ClearingHouse UT", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000B"
    const POOL_C_ADDRESS = "0x000000000000000000000000000000000000000C"
    const DEFAULT_FEE = 3000
    let baseToken: TestERC20
    let clearingHouse: ClearingHouse
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await waffle.loadFixture(clearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        uniV3Factory = _clearingHouseFixture.mockUniV3Factory
        // NOTICE: can not call waffle.loadFixture twice in beforeEach, it causes an unexpected result.
        baseToken = await deployERC20()

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })
    })

    describe("# addPool", () => {
        // @SAMPLE - addPool
        it("should be able to add a UniswapV3 pool and send an event", async () => {
            // check event has been sent
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE))
                .to.emit(clearingHouse, "PoolAdded")
                .withArgs(baseToken.address, DEFAULT_FEE, POOL_A_ADDRESS)

            expect(await clearingHouse.poolMap(POOL_A_ADDRESS)).to.eq(true)
        })

        it("should be able to add multiple UniswapV3 pools", async () => {
            const baseToken2 = await deployERC20()
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)

            // mock the return address of `getPool`
            uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return POOL_B_ADDRESS
            })
            await clearingHouse.addPool(baseToken.address, "10000")

            // mock the return address of `getPool`
            uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return POOL_C_ADDRESS
            })
            await clearingHouse.addPool(baseToken2.address, DEFAULT_FEE)

            // verify poolMap
            expect(await clearingHouse.poolMap(POOL_A_ADDRESS)).to.eq(true)
            expect(await clearingHouse.poolMap(POOL_B_ADDRESS)).to.eq(true)
            expect(await clearingHouse.poolMap(POOL_C_ADDRESS)).to.eq(true)
        })

        it("force error, pool is not existent in uniswap v3", async () => {
            uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return EMPTY_ADDRESS
            })
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_NEP")
        })

        it("force error, pool is existent in ClearingHouse", async () => {
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_EP")
        })
    })
})

async function deployERC20(): Promise<TestERC20> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    return (await tokenFactory.deploy("Test", "Test")) as TestERC20
}
