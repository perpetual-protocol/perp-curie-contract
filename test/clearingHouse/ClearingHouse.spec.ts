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
        let mockedPool: MockContract

        beforeEach(async () => {
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            mockedPool = await smockit(pool)

            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with([
                "792281625142643375935439503360", // sqrt(100) * 2^96
                0,
                0,
                0,
                0,
                0,
                false, // unused
            ])
            mockedPool.smocked.observe.will.return.with([
                [0, 165600000], // markTwap = 1.0001 ^ ((165600000 - 0) / 3600) = 99.4614384055 ~ 100
                [0, 0],
            ])

            await clearingHouse.addPool(baseToken.address, 10000)
            fundingBufferPeriod = (await clearingHouse.fundingPeriod()).div(2)
        })

        it("register positive premium fraction when mark price > index price", async () => {
            mockedPool.smocked.observe.will.return.with([
                [0, 166320000], // markTwap = 1.0001 ^ ((166320000 - 0) / 3600) = 101.4705912784
                [0, 0],
            ])

            await expect(clearingHouse.updateFunding(baseToken.address))
                .to.emit(clearingHouse, "FundingRateUpdated")
                .withArgs(
                    "612746365981925", // (101.4705912784 - 100) / 24 / 100 = 0.000612746366
                    parseEther("100"),
                )

            expect(await clearingHouse.getFundingHistoryLength(baseToken.address)).eq(1)
            expect(await clearingHouse.getPremiumFraction(baseToken.address, 0)).eq(
                "61274636598192578", // (101.4705912784 - 100) / 24 = 0.0612746366
            )
            expect(await clearingHouse.getFundingHistoryLength(baseToken.address)).eq(1)
            expect(await clearingHouse.getSqrtMarkPriceX96AtIndex(baseToken.address, 0)).eq(
                "792281625142643375935439503360", // sqrt(100) * 2^96
            )
        })

        it("register negative premium fraction when mark price < index price", async () => {
            mockedPool.smocked.observe.will.return.with([
                [0, 164880000], // markTwap = 1.0001 ^ ((164880000 - 0) / 3600) = 97.4920674557
                [0, 0],
            ])

            await expect(clearingHouse.updateFunding(baseToken.address))
                .to.emit(clearingHouse, "FundingRateUpdated")
                .withArgs(
                    "-1044971893446306", // (97.4920674557 - 100) / 24 / 100 = -0.001044971893
                    parseEther("100"),
                )

            expect(await clearingHouse.getFundingHistoryLength(baseToken.address)).eq(1)
            expect(await clearingHouse.getPremiumFraction(baseToken.address, 0)).eq(
                "-104497189344630680", // (97.4920674557 - 100) / 24 = -0.1044971893
            )
            expect(await clearingHouse.getFundingHistoryLength(baseToken.address)).eq(1)
            expect(await clearingHouse.getSqrtMarkPriceX96AtIndex(baseToken.address, 0)).eq(
                "792281625142643375935439503360", // sqrt(100) * 2^96
            )
        })

        // TODO implement after oracle is ready for mock
        // it("register zero premium fraction when mark price = index price", async () => {})

        it("set the next funding time to the next exact hour mark if the previous one is done more than 30 mins. ago", async () => {
            const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
            const nextHourTimestamp = Math.ceil(lastTimestamp / 3600) * 3600
            const nextHourTimestampPlusOne = nextHourTimestamp + 1
            // deliberately update funding 1 sec. after the hour mark
            await waffle.provider.send("evm_setNextBlockTimestamp", [nextHourTimestampPlusOne])
            await clearingHouse.updateFunding(baseToken.address)

            expect(await clearingHouse.getNextFundingTime(baseToken.address)).eq(
                // the earliest next funding time should still on the exact next hour mark
                BigNumber.from(nextHourTimestamp + 3600),
            )
        })

        it("set the next funding time to 30 mins. later if the previous one is done less than 30 mins. ago", async () => {
            const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
            const nextHourTimestampMinusOne = Math.ceil(lastTimestamp / 3600) * 3600 - 1
            await waffle.provider.send("evm_setNextBlockTimestamp", [nextHourTimestampMinusOne])
            await clearingHouse.updateFunding(baseToken.address)

            expect(await clearingHouse.getNextFundingTime(baseToken.address)).eq(
                // the earliest next funding time should be 30 mins. after the previous one since it was too close to the next hour mark
                BigNumber.from(nextHourTimestampMinusOne).add(fundingBufferPeriod),
            )
        })

        it("force error, can't update funding too frequently", async () => {
            await clearingHouse.updateFunding(baseToken.address)
            const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
            await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + Number(fundingBufferPeriod) - 1])
            await expect(clearingHouse.updateFunding(baseToken.address)).to.be.revertedWith("CH_UFTE")
        })
    })
})
