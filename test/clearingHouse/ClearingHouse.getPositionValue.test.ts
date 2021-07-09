import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"

import { BaseToken } from "../../typechain/BaseToken"
import { MockContract } from "@eth-optimism/smock"
import { encodePriceSqrt } from "../shared/utilities"
import { expect } from "chai"
import { parseEther } from "@ethersproject/units"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"

describe("ClearingHouse.funding", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")

        // take care alice
        await collateral.mint(alice.address, parseEther("10000"))
        await collateral.connect(alice).approve(clearingHouse.address, parseEther("10000"))
        await clearingHouse.connect(alice).deposit(parseEther("10000"))
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

        // take care bob
        await collateral.mint(bob.address, parseEther("1000"))
        await collateral.connect(bob).approve(clearingHouse.address, parseEther("1000"))
        await clearingHouse.connect(bob).deposit(parseEther("1000"))
        await clearingHouse.connect(bob).mint(baseToken.address, parseEther("2"))
    })

    async function forward(seconds: number) {
        const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
        await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + seconds])
        await waffle.provider.send("evm_mine", [])
    }

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("# getPositionValue", () => {
        beforeEach(async () => {
            // price at 50200 == 151.3733069
            await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        })

        it("value = 0, if the position = 0", async () => {
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address)).eq(0)

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address)).eq(0)
        })

        it.only("swap 1 time", async () => {
            // provide 1000 liquidity = 1000 * 0.122414646 = 122.414646
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            // bob short 0.4084104205 / 0.99 = 0.4125357783
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.4125357783"),
                sqrtPriceLimitX96: 0,
            })
            // mark price should be 149.863446 (tick = 50099.75001)

            // if we get SqrtMarkTwapPriceX96 with timeInterval == 0, the value should be same as the initial price = 151.3733069
            // await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 0)).toString() == 11993028956124528295336454433927
            // (11993028956124528295336454433927 / 2^96) = 151.3733068587
            // -> no need to pow(151.3733068587, 2) here as the initial value is already powered in their system, for unknown reason

            await forward(900)

            // await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).toString() = 969864706335398656864177991756
            // (969864706335398656864177991756 / 2^96) ^ 2 = 149.8522069973
            // 149.8522069973 != 149.863446, the reason is:
            // tickCumulative inside their system uses integer tick
            // thus, instead of expecting exact mark price 149.863446, whose tick index is 50099.75001
            // the Twap price comes from floor(50099.75001) = 50099
            // -> 1.0001 ^ (50099 * (900 - 0) / 900) = 149.8522069974 ~= 149.8522069973

            expect(await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).eq(
                "969864706335398656864177991756",
            )

            // expect alice, bob, carol's value
            // 99999999999999998
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address)).eq(0)
        })

        it("get correct number for maker before any update funding", async () => {
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it("get correct number for maker in positive funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("99999999999999998")
            // TODO for now, position size is 0.099 for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "12375003379192555",
            )
            //   position size = -0.1
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.1"))
            //   funding payment = -0.1 * (153.9531248192 - 150.953124) / 24 = 0.012500000341
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(
                "-12500003413325814",
            )
        })

        it("get correct number for maker in negative funding rate", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("156.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("99999999999999998")
            // TODO for now, position size is 0.099 for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 156.953124) / 24 = -0.01237499662
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-12374996620807443",
            )
            //   position size = -0.1
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.1"))
            //   funding payment = -0.1 * (153.9531248192 - 156.953124) / 24 = 0.01249999659
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq("12499996586674185")
        })

        it("get correct number for maker in multiple orders and funding rates", async () => {
            // alice to add her second open order
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            // first update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // bob short
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })

            // afterwards, mark price = 149.403346446539268519

            // forward another 3600 secs
            await forward(3600)

            // second update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("152.403346", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // alice
            // position size = 0.1 + 1 ~= 1.1
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq("1099999999999999996")
            // TODO for now, position size is 0.099, 1.089, respectively for funding calculation. We should take fee into considerations in the future
            // funding payment = 0.099 * (153.9531248192 - 150.953124) / 24 = 0.01237500338
            // funding payment = 1.089 * (149.403346446539268519 - 152.403346) / 24 = -0.1361249797
            // 0.01237500338 + (-0.1361249797) = -0.1237499763
            expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).eq(
                "-123749976359088135",
            )
        })

        it("get correct number when there is no positions", async () => {
            // carol mint token but not trading (zero positions)
            await collateral.mint(carol.address, parseEther("10000"))
            await collateral.connect(carol).approve(clearingHouse.address, parseEther("10000"))
            await clearingHouse.connect(carol).deposit(parseEther("10000"))
            await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10"))

            // update funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("152.403346", 6), 0, 0, 0]
            })
            await clearingHouse.updateFunding(baseToken.address)

            // carol
            // position size = 0
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(0)
            // funding payment = 0 * (154.4310961 - 152.403346) / 24 = 0
            expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).eq(0)
        })

        it("get correct number when base token does not exist", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })

            await clearingHouse.updateFunding(baseToken.address)

            // alice
            expect(await clearingHouse.getPendingFundingPayment(alice.address, quoteToken.address)).eq(0)
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("alice stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("carol stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("feeGrowthInsideLastBase carol 50000 - 50200")
// console.log((await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[3].toString())
// console.log("feeGrowthInsideLastQuote carol 50000 - 50200")
// console.log((await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[4].toString())
// console.log("feeGrowthInsideLastBase alice 50000 - 50400")
// console.log((await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[3].toString())
// console.log("feeGrowthInsideLastQuote alice 50000 - 50400")
// console.log((await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[4].toString())

// console.log("----------------------")
// console.log("base diff")
// console.log(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address)).toString())
// console.log("quote diff")
// console.log(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address)).toString())
// // === useful console.log for verifying stats ===
