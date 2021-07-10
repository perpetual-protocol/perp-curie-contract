import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { BaseToken } from "../../typechain/BaseToken"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.getPositionSize", () => {
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

        // alice
        await collateral.mint(alice.address, parseEther("10000"))
        await collateral.connect(alice).approve(clearingHouse.address, parseEther("10000"))
        await clearingHouse.connect(alice).deposit(parseEther("10000"))
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

        // bob
        await collateral.mint(bob.address, parseEther("1000"))
        await collateral.connect(bob).approve(clearingHouse.address, parseEther("1000"))
        await clearingHouse.connect(bob).deposit(parseEther("1000"))
        await clearingHouse.connect(bob).mint(baseToken.address, parseEther("10"))

        // carol
        await collateral.mint(carol.address, parseEther("1000"))
        await collateral.connect(carol).approve(clearingHouse.address, parseEther("1000"))
        await clearingHouse.connect(carol).deposit(parseEther("1000"))
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10"))
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
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)
        })

        it("value = 0, if position size = 0", async () => {
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address, 0)).eq(0)

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address, 0)).eq(0)
        })

        it("bob(taker) swaps 1 time", async () => {
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

            // default timeInterval is 15 minutes = 900 seconds
            await forward(900)

            // (969864706335398656864177991756 / 2^96) ^ 2 = 149.8522069973
            // 149.8522069973 != 149.863446, the reason is:
            // tickCumulative inside their system uses "integer" tick
            // thus,
            // 1. instead of the exact mark price 149.863446, whose tick index is 50099.75001 -> floor() -> 50099
            // 2. when considering the accumulator, we also need floor(): (50099 * 900 / 900) = 50099 -> floor() -> 50099
            // -> 1.0001 ^ 50099 = 149.8522069974

            expect(await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).eq(
                "969864706335398656864177991756",
            )
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(
                parseEther("0.412535778299999998"),
            )
            // 149.8522069974 * 0.412535778299999998 = 61.8193968436
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address, 900)).eq(
                parseEther("61.819396843654672493"),
            )

            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.4125357783"))
            // 149.8522069974 * -0.4125357783 = -61.8193968436
            expect(await clearingHouse.getPositionValue(bob.address, baseToken.address, 900)).eq(
                parseEther("-61.819396843654672792"),
            )
        })

        it("bob swaps 2 time", async () => {
            // provide 1000 liquidity = 1000 * 0.122414646 = 122.414646
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            // bob shorts 0.2042052103 / 0.99 = 0.2062678892
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.2062678892"),
                sqrtPriceLimitX96: 0,
            })
            // mark price should be 150.6155385 (tick = 50149.8122)

            await forward(300)

            // bob shorts 0.2042052103 / 0.99 = 0.2062678892
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.2062678892"),
                sqrtPriceLimitX96: 0,
            })
            // mark price should be 149.863446 (tick = 50099.75001)

            await forward(600)

            // (970640869716903962852171321230 / 2^96) ^ 2 = 150.0921504352
            // ((50149 * 300 + 50099 * 600) / 900) = 50115.6666666667 -> floor() -> 50115
            // -> 1.0001 ^ 50115 = 150.0921504352

            expect(await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).eq(
                "970640869716903962852171321230",
            )
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(
                parseEther("0.412535778399999998"),
            )
            // 150.0921504352 * 0.412535778399999998 = 61.9183821115
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address, 900)).eq(
                parseEther("61.918382111520063461"),
            )

            // short
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.4125357784"))
            // 150.0921504352 * -0.4125357784 = -61.9183821115
            expect(await clearingHouse.getPositionValue(bob.address, baseToken.address, 900)).eq(
                parseEther("-61.918382111520063761"),
            )
        })

        it.skip("bob swaps 2 time, while the second time is out of carol's range", async () => {
            // provide 1000 liquidity = 1000 * 0.122414646 = 122.414646
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
            })

            // bob shorts 0.2042052103 / 0.99 = 0.2062678892
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.2062678892"),
                sqrtPriceLimitX96: 0,
            })
            // mark price should be 150.6155385 (tick = 50149.8122)

            await forward(300)

            // bob shorts 0.2042052103 / 0.99 = 0.2062678892
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.2062678892"),
                sqrtPriceLimitX96: 0,
            })
            // mark price should be 149.863446 (tick = 50099.75001)

            await forward(600)

            console.log("getSqrtMarkTwapPriceX96")
            console.log((await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).toString())

            console.log("alice")
            console.log("getPositionSize")
            console.log((await clearingHouse.getPositionSize(alice.address, baseToken.address)).toString())
            console.log("getPositionValue")
            console.log((await clearingHouse.getPositionValue(alice.address, baseToken.address, 900)).toString())

            console.log("bob")
            console.log("getPositionSize")
            console.log((await clearingHouse.getPositionSize(bob.address, baseToken.address)).toString())
            console.log("getPositionValue")
            console.log((await clearingHouse.getPositionValue(bob.address, baseToken.address, 900)).toString())

            // (970640869716903962852171321230 / 2^96) ^ 2 = 150.0921504352
            // ((50149 * 300 + 50099 * 600) / 900) = 50115.6666666667 -> floor() -> 50115
            // -> 1.0001 ^ 50115 = 150.0921504352

            expect(await clearingHouse.getSqrtMarkTwapPriceX96(baseToken.address, 900)).eq(
                "970640869716903962852171321230",
            )
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).eq(
                parseEther("0.412535778399999998"),
            )
            // 150.0921504352 * 0.412535778399999998 = 61.9183821115
            expect(await clearingHouse.getPositionValue(alice.address, baseToken.address, 900)).eq(
                parseEther("61.918382111520063461"),
            )

            // short
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).eq(parseEther("-0.4125357784"))
            // 150.0921504352 * -0.4125357784 = -61.9183821115
            expect(await clearingHouse.getPositionValue(bob.address, baseToken.address, 900)).eq(
                parseEther("-61.918382111520063761"),
            )
        })
    })
})
