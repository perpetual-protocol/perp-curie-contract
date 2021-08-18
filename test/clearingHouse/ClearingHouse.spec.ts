import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedClearingHouseFixture, mockedTokenTo } from "./fixtures"

describe("ClearingHouse Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000b"
    const DEFAULT_FEE = 3000

    let clearingHouse: ClearingHouse
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(mockedClearingHouseFixture)
        clearingHouse = _clearingHouseFixture.clearingHouse
        baseToken = _clearingHouseFixture.mockedBaseToken
        quoteToken = _clearingHouseFixture.mockedVUSD
        uniV3Factory = _clearingHouseFixture.mockedUniV3Factory

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("# addPool", () => {
        let poolFactory
        let pool
        let mockedPool
        beforeEach(async () => {
            poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
        })

        describe("after the pool is initialized", () => {
            beforeEach(async () => {
                mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            })

            // @SAMPLE - addPool
            it("add a UniswapV3 pool and send an event", async () => {
                // check event has been sent
                await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE))
                    .to.emit(clearingHouse, "PoolAdded")
                    .withArgs(baseToken.address, DEFAULT_FEE, mockedPool.address)

                expect(await clearingHouse.getPool(baseToken.address)).to.eq(mockedPool.address)
            })

            it("add multiple UniswapV3 pools", async () => {
                await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)
                expect(await clearingHouse.getPool(baseToken.address)).to.eq(mockedPool.address)

                const baseToken2 = await mockedTokenTo(ADDR_LESS_THAN, quoteToken.address)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await clearingHouse.addPool(baseToken2.address, DEFAULT_FEE)
                // verify isPoolExisted
                expect(await clearingHouse.getPool(baseToken2.address)).to.eq(mockedPool2.address)
            })

            it("force error, pool is not existent in uniswap v3", async () => {
                uniV3Factory.smocked.getPool.will.return.with(() => {
                    return EMPTY_ADDRESS
                })
                await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_NEP")
            })

            it("force error, pool is already existent in ClearingHouse", async () => {
                await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)
                await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_EP")
            })

            it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
                const tokenWithLongerAddr = await mockedTokenTo(ADDR_GREATER_THAN, quoteToken.address)
                await expect(clearingHouse.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith(
                    "CH_IB",
                )
            })
        })

        it("force error, before the pool is initialized", async () => {
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_PNI")
        })
    })

    describe("# getRequiredCollateral", () => {})
})
