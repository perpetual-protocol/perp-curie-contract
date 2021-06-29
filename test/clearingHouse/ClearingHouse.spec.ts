import { MockContract, smockit } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
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
    })

    describe("# addPool", () => {
        // @SAMPLE - addPool
        it("add a UniswapV3 pool and send an event", async () => {
            // check event has been sent
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE))
                .to.emit(clearingHouse, "PoolAdded")
                .withArgs(baseToken.address, DEFAULT_FEE, POOL_A_ADDRESS)

            const pool = await clearingHouse.getPool(baseToken.address)
            expect(pool).to.eq(POOL_A_ADDRESS)
        })

        it("add multiple UniswapV3 pools", async () => {
            const baseToken2 = await mockedTokenTo(ADDR_LESS_THAN, quoteToken.address)
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)

            // mock the return address of `getPool`
            uniV3Factory.smocked.getPool.will.return.with(() => {
                return POOL_B_ADDRESS
            })
            await clearingHouse.addPool(baseToken2.address, DEFAULT_FEE)

            // verify isPoolExisted
            const pool = await clearingHouse.getPool(baseToken.address)
            expect(pool).to.eq(POOL_A_ADDRESS)
            const pool2 = await clearingHouse.getPool(baseToken2.address)
            expect(pool2).to.eq(POOL_B_ADDRESS)
        })

        it("force error, pool is not existent in uniswap v3", async () => {
            uniV3Factory.smocked.getPool.will.return.with(() => {
                return EMPTY_ADDRESS
            })
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_NEP")
        })

        it("force error, pool is existent in ClearingHouse", async () => {
            await clearingHouse.addPool(baseToken.address, DEFAULT_FEE)
            await expect(clearingHouse.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("CH_EP")
        })

        it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
            const tokenWithLongerAddr = await mockedTokenTo(ADDR_GREATER_THAN, quoteToken.address)
            await expect(clearingHouse.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith("CH_IB")
        })
    })
    describe("# updateFunding", async () => {
        let fundingBufferPeriod

        beforeEach(async () => {
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)

            uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                return mockedPool.address
            })

            mockedPool.smocked.slot0.will.return.with([10, 2, 2, 2, 2, 0, true])
            mockedPool.smocked.observe.will.return.with([
                [360000, 396000],
                [0, 0],
            ])

            await clearingHouse.addPool(baseToken.address, 10000)

            fundingBufferPeriod = (await clearingHouse.fundingPeriod()).div(2)
        })

        it.only("consecutive update funding calls must be at least fundingBufferPeriod apart", async () => {
            await clearingHouse.updateFunding(baseToken.address)
            const originalNextFundingTime = await clearingHouse.getNextFundingTime(baseToken.address)
            const updateFundingTimestamp = originalNextFundingTime.add(fundingBufferPeriod).add(1)
            console.log(`updateFundingTimestamp: ${+updateFundingTimestamp}`)
            await waffle.provider.send("evm_setNextBlockTimestamp", [+updateFundingTimestamp])
            await clearingHouse.updateFunding(baseToken.address)
            expect(await clearingHouse.getNextFundingTime(baseToken.address)).eq(
                updateFundingTimestamp.add(fundingBufferPeriod),
            )
        })
    })
})
