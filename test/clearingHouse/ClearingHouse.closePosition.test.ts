import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    OrderBook,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps } from "../shared/time"
import { encodePriceSqrt, mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse closePosition", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let lowerTick = "50000" // 148.3760629231
    let upperTick = "50200" // 151.3733068587
    let pool: UniswapV3Pool

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange as TestExchange
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        const collateralDecimals = await collateral.decimals()
        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for bob
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)

        // prepare collateral for carol
        await collateral.transfer(carol.address, amount)
        await deposit(carol, vault, 1000, collateral)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918

    describe("one maker; initialized price = 151.373306858723226652", () => {
        beforeEach(async () => {
            let initPrice = "151.373306858723226652"
            await initMarket(fixture, initPrice, undefined, 0)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: "0",
                quote: parseEther("0.122414646"),
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)
        })

        it("one taker swaps base to quote and then closes", async () => {
            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334175725025 quote
            // bob gets 0.06151334175725025 * 0.99 = 0.06089820833967775
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker pays 0.06151334175725025 / 0.99 = 0.06213468864 quote to pay back 0.0004084104205 base
            // using original sqrtPriceX96 to avoid over price limit
            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob has dust due to uniswapV3
            const bobDust = 153

            // assure that the position of the taker is closed completely, and so is maker's position
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            const [bobNetQuoteBalance, bobFee] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(bobNetQuoteBalance.add(bobFee)).to.be.closeTo("0", bobDust)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const pnlMaker = parseEther("0.001236480304009373")
            const [aliceNetQuoteBalance, aliceFee] = await accountBalance.getNetQuoteBalanceAndPendingFee(alice.address)
            expect(aliceNetQuoteBalance.add(aliceFee)).to.eq(pnlMaker)

            // assure pnls of maker & taker are the same (of different sign)
            // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlTaker = (await accountBalance.getPnlAndPendingFee(bob.address))[0]
            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[1]
            let feeMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[2]
            expect(owedRealizedPnlTaker.abs()).to.be.closeTo(owedOrUnrealizedPnlMaker.add(feeMaker).abs(), bobDust)
            expect(owedOrUnrealizedPnlMaker.add(feeMaker)).to.eq(pnlMaker)

            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // after removing liquidity, maker's unrealizedPnl becomes owedRealizedPnl, thus getting the first element [0] of the array
            owedOrUnrealizedPnlMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            expect(owedOrUnrealizedPnlMaker).to.be.closeTo(pnlMaker, 1)
        })

        it("two takers open position and then close; one maker", async () => {
            const base = parseEther("0.0004084104205")

            // bob & carol swap for the same amount in total as the above case
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: base.div(2),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: base.sub(base.div(2)),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob closes position first
            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // using original sqrtPriceX96 to avoid over price limit
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // carol has dust due to uniswapV3
            const carolDust = 153

            // assure that position of takers are closed completely, and so is maker's position
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

            // takers sell all quote, making netQuoteBalance == 0
            const [bobNetQuoteBalance] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            const [carolNetQuoteBalance] = await accountBalance.getNetQuoteBalanceAndPendingFee(carol.address)
            const [aliceNetQuoteBalance, aliceFee] = await accountBalance.getNetQuoteBalanceAndPendingFee(alice.address)

            expect(bobNetQuoteBalance).to.eq(0)
            expect(carolNetQuoteBalance).to.be.closeTo("0", carolDust)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const pnlMaker = parseEther("0.001236480304009373")
            expect(aliceNetQuoteBalance.add(aliceFee)).to.eq(pnlMaker)

            // assure pnls of maker & takers are the same (of different sign)
            // for takers, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlBob = (await accountBalance.getPnlAndPendingFee(bob.address))[0]
            const owedRealizedPnlCarol = (await accountBalance.getPnlAndPendingFee(carol.address))[0]
            // as bob opens and also closes first, his pnl should be better than carol
            expect(owedRealizedPnlBob).to.be.gte(owedRealizedPnlCarol)

            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[1]
            let feeMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[2]
            expect(owedRealizedPnlBob.add(owedRealizedPnlCarol).abs()).to.be.closeTo(
                owedOrUnrealizedPnlMaker.add(feeMaker).abs(),
                carolDust,
            )
            expect(owedOrUnrealizedPnlMaker.add(feeMaker)).to.eq(pnlMaker)

            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // after removing liquidity, maker's unrealizedPnl becomes owedRealizedPnl, thus getting the first element [0] of the array
            owedOrUnrealizedPnlMaker = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            expect(owedOrUnrealizedPnlMaker).to.be.closeTo(pnlMaker, 1)
        })
    })

    // different range
    describe("two makers; initialized price = 148.3760629", () => {
        beforeEach(async () => {
            let initPrice = "148.3760629"
            await initMarket(fixture, initPrice, undefined, 0)
            await mockIndexPrice(mockedPriceFeedDispatcher, "148")
        })

        it("ranges of makers are the same; alice receives 3/4 of fee, while carol receives only 1/4", async () => {
            const base = 0.000816820841

            // add base liquidity
            // 0.000816820841 * 3 = 0.002450462523
            const addLiquidityParamsAlice = {
                baseToken: baseToken.address,
                base: parseEther((base * 3).toString()),
                quote: "0",
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.002450462523 base to pool
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

            // add base liquidity
            const addLiquidityParamsCarol = {
                baseToken: baseToken.address,
                base: parseEther(base.toString()),
                quote: "0",
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.000816820841 base to pool
            await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

            // bob swap
            // quote: 0.112414646 / 0.99 = 0.1135501475
            // to base: 0.0007558893279
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.1135501475"),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob swap
            // base: 0.0007558893279
            // B2QFee: CH actually shorts 0.0007558893279 / 0.99 = 0.0007635245736 and get 0.112414646 quote
            // bob gets 0.112414646 * 0.99 = 0.1112904995
            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // assure that the position of the taker is closed completely, and so is maker's position
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            const [bobNetQuoteBalance] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(bobNetQuoteBalance).to.eq(0)

            // makers get 0.1135501475 * 0.01 + 0.112414646 * 0.01 = 0.002259647935
            const pnlMakers = parseEther("0.00225964793525004")
            const [aliceNetQuoteBalance, aliceFee] = await accountBalance.getNetQuoteBalanceAndPendingFee(alice.address)
            const [carolNetQuoteBalance, carolFee] = await accountBalance.getNetQuoteBalanceAndPendingFee(carol.address)

            expect(aliceNetQuoteBalance.add(aliceFee).add(carolNetQuoteBalance.add(carolFee))).to.eq(pnlMakers)

            // assure pnls of makers & taker are the same (of different sign)
            // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlTaker = (await accountBalance.getPnlAndPendingFee(bob.address))[0]
            // for makers, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlAlice = (await accountBalance.getPnlAndPendingFee(alice.address))[1]
            let feeAlice = (await accountBalance.getPnlAndPendingFee(alice.address))[2]
            let owedOrUnrealizedPnlCarol = (await accountBalance.getPnlAndPendingFee(carol.address))[1]
            let feeCarol = (await accountBalance.getPnlAndPendingFee(carol.address))[2]
            expect(owedRealizedPnlTaker.abs()).to.be.closeTo(
                owedOrUnrealizedPnlAlice.add(feeAlice).add(owedOrUnrealizedPnlCarol.add(feeCarol)).abs(),
                10,
            )
            expect(owedOrUnrealizedPnlAlice.add(feeAlice).add(owedOrUnrealizedPnlCarol.add(feeCarol))).to.eq(pnlMakers)
            // alice receives about 3 times the fee of carol
            expect(feeAlice).to.be.closeTo(feeCarol.mul(3), 10)
        })

        describe("one maker closes position before the taker closes", () => {
            it("ranges of makers are the same", async () => {
                const base = 0.000816820841

                // add base liquidity
                // 0.000816820841 * 3 = 0.002450462523
                const addLiquidityParamsAlice = {
                    baseToken: baseToken.address,
                    base: parseEther((base * 3).toString()),
                    quote: "0",
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.002450462523 base to pool
                await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                // add base liquidity
                const addLiquidityParamsCarol = {
                    baseToken: baseToken.address,
                    base: parseEther(base.toString()),
                    quote: "0",
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // bob swap
                // quote: 0.112414646 / 0.99 = 0.1135501475
                // to base: 0.0007558893279
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.1135501475"),
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                await clearingHouse.connect(carol).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: (
                        await orderBook.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // carol has 1/4 of the opposite position of bob = short 0.0007558893279 / 4 = 0.000188972332 base
                expect(
                    (await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).abs(),
                ).to.be.closeTo(
                    (await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).abs().div(4),
                    10,
                )

                // carol closes position
                // price before: 149.0615125299
                // x * y = l ^ 2 = 9
                // y / x = 149.0615125299
                // y ^ 2 = 1,341.5536127691
                // y = 36.62722502141
                // x = 0.24571886062
                // (0.24571886062 - 0.00018897233202709) * (36.62722502141 + y') = 9
                // y' = 0.02819018183
                // y' / 0.99 = 0.02847493114
                await clearingHouse.connect(carol).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // price after: 149.2910515224
                // Verification:
                // 3 * (1 / sqrt(149.0615125299) - 1 / sqrt(149.2910515224)) = 0.000188972332
                // 3 * (sqrt(149.2910515224) - sqrt(149.0615125299)) = 0.02819018155 (imprecision)

                expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)
                // netQuoteBalance == 0 after closing position
                const [carolNetQuoteBalance] = await accountBalance.getNetQuoteBalanceAndPendingFee(carol.address)
                expect(carolNetQuoteBalance).to.eq(0)

                let owedRealizedPnlCarol = (await accountBalance.getPnlAndPendingFee(carol.address))[0]
                // tx fee: 0.1135501475 * 0.01 * 0.25 = 0.0002838753688
                // quote: 0.1135501475 * 0.99 * 0.25 = 0.02810366151
                // quote paid for base: 0.02847493114
                // sum: 0.0002838753688 + 0.02810366151 - 0.02847493114 = -0.0000873942612 (imprecision)
                expect(owedRealizedPnlCarol).to.eq(parseEther("-0.000087393988262259"))

                // bob swap
                // base: 0.000755889328
                // B2QFee: CH actually shorts 0.000755889328 / 0.99 = 0.0007635245738
                // then Uniswap charges 0.0007635245738 * 0.01 = 0.000007635245738 as fee
                // y = 36.62722502141 + 0.02819018183 = 36.6554152032
                // x = 0.24571886062 - 0.000188972332 = 0.2455298883
                // (0.2455298883 + 0.0007635245738 * 0.99) * (36.6554152032 - y') = 9
                // y' = 0.1125011678
                // bob gets 0.1125011678 * 0.99 = 0.1113761561
                await clearingHouse.connect(bob).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // price after: 148.3760629231
                // Verification:
                // 3 * (1 / sqrt(148.3760629231) - 1 / sqrt(149.2910515224)) = 0.0007558893281
                // 3 * (sqrt(149.2910515224) - sqrt(148.3760629231)) = 0.1125011661

                // assure that the position of the taker is closed completely, and so is maker's position
                expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
                expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

                // taker sells all quote, making netQuoteBalance == 0
                const [bobNetQuoteBalance] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
                expect(bobNetQuoteBalance).to.eq(0)

                // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
                let owedRealizedPnlTaker = (await accountBalance.getPnlAndPendingFee(bob.address))[0]
                // 0.1113761561 (bob gets when closing) - 0.1135501475 (bob pays when opening) = -0.0021739914
                expect(owedRealizedPnlTaker).to.eq(parseEther("-0.00217399308735427"))

                // for the only maker, it's unrealizedPnl, thus getting the second element [1] of the array
                let [, , pendingFeeAlice] = await accountBalance.getPnlAndPendingFee(alice.address)

                // assure pnls of makers & takers are the same (of different sign)
                expect(owedRealizedPnlCarol.add(owedRealizedPnlTaker).add(pendingFeeAlice)).to.be.closeTo("0", 120)

                // alice get 0.1135501475 * 0.01 * 0.75 + (0.02847493114 + 0.1125011678) * 0.01 = 0.002261387096
                const pnlAlice = parseEther("0.002261387075616418")
                expect(pendingFeeAlice).to.eq(pnlAlice)
            })

            it("one maker close half liquidity and open position", async () => {
                const base = 0.000816820841

                // add base liquidity
                // 0.000816820841 * 3 = 0.002450462523
                const addLiquidityParamsAlice = {
                    baseToken: baseToken.address,
                    base: parseEther((base * 3).toString()),
                    quote: "0",
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.002450462523 base to pool
                await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                // add base liquidity
                const addLiquidityParamsCarol = {
                    baseToken: baseToken.address,
                    base: parseEther(base.toString()),
                    quote: "0",
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // bob swap
                // quote: 0.112414646 / 0.99 = 0.1135501475
                // to base: 0.0007558893279
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.1135501475"),
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const carolLiquidity = (
                    await orderBook.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                ).liquidity

                // carol has 25% liquidity of range
                // positionSize: -0.0007558893279 * 0.25 = -0.00018897233
                const carolPos = await accountBalance.getTotalPositionSize(carol.address, baseToken.address)
                expect(carolPos).to.be.eq(parseEther("-0.00018897233202709"))

                // carol get short position
                // carol's baseDebt: 0.000816820841
                // carol's quoteDebt: 0
                // carol's base in pool: 0.000816820841-0.00018897233 = 0.00062784851
                // carol's quote in pool: 0.112414646*0.25 = 0.0281036615
                // carol's deltaBaseDebt: 0.000816820841 / 2 = 0.00040841042
                // carol's deltaQuoteDebt: 0
                // deltaTakerBase: removedBase - deltaBaseDebt = (0.00062784851/2)- 0.00040841042 = -0.00009448616
                // deltaTakerQuote: removedQuote - deltaQuoteDebt = (0.0281036615/2)- 0 = 0.01405183075
                await expect(
                    clearingHouse.connect(carol).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: carolLiquidity.div(2),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        carol.address,
                        baseToken.address,
                        parseEther("-0.000094486166013545"), // exchangedPositionSize
                        parseEther("0.014051830753124999"), // exchangedPositionNotional
                        0, // fee
                        parseEther("0.014051830753124999"), // openNotional
                        "0", // realizedPnl
                        Object, // sqrtPriceAfterX96
                    )

                const carolTakerPos = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos).to.be.eq(carolPos.div(2))
                expect(carolTakerPos).to.be.eq(parseEther("-0.000094486166013545"))

                // carol increases short position
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.0001"), // avoid out of liquidity
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                const carolTakerPos2 = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos2).to.be.eq(carolTakerPos.add(parseEther("-0.0001")))

                // carol long
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.001"), // avoid out of liquidity
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const carolTakerPos3 = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos3).to.be.eq(carolTakerPos2.add(parseEther("0.001")))
            })
        })
    })

    describe("dust test for UniswapV3Broker.swap()", () => {
        // this test will fail if the _DUST constant in UniswapV3Broker is set to 1 (no dust allowed)
        it("a trader swaps base to quote and then closes; one maker", async () => {
            let initPrice = "151.3733069"
            await initMarket(fixture, initPrice, undefined, 0)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: "0",
                quote: parseEther("0.122414646"),
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334175725025 quote
            // bob gets 0.06151334175725025 * 0.99 = 0.06089820833967775
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: encodePriceSqrt(initPrice, 1),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // assure that the position of the taker is closed completely, and so is maker's position
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)
        })
    })

    describe("close position when user is maker and taker", async () => {
        let lowerTick: number, upperTick: number
        beforeEach(async () => {
            let initPrice = "151.3733069"
            const { maxTick, minTick } = await initMarket(fixture, initPrice, undefined, 0)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            lowerTick = minTick
            upperTick = maxTick
        })

        it("taker close position only effect taker position size", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 10, 1000, lowerTick, upperTick)

            // bob swap to let alice has maker impermanent position
            await q2bExactInput(fixture, bob, 10)

            // alice has maker position
            const totalPositionSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
            const takerPositionSize = await accountBalance.getTakerPositionSize(alice.address, baseToken.address)
            const makerPositionSize = totalPositionSize.sub(takerPositionSize)
            expect(makerPositionSize).to.be.lt(0)
            expect(takerPositionSize).to.be.eq(0)

            // alice has taker position, swap 10 quote to 0.06350274755 base
            await q2bExactInput(fixture, alice, 10)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                "63502747547593254",
            )
            // total position unchanged
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.eq(
                totalPositionSize,
            )

            // alice close position
            await closePosition(fixture, alice)
            // taker position size is 0
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(0)
            // total position(only maker) unchanged
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.eq(
                makerPositionSize,
            )
        })

        it("force error, alice has 0 taker position, close nothing", async () => {
            await addOrder(fixture, alice, 10, 1000, lowerTick, upperTick)

            // bob swap, alice has maker impermanent position
            await q2bExactInput(fixture, bob, 10)

            // alice has maker position and 0 taker position
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(0)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(0)

            // alice close position
            await expect(closePosition(fixture, alice)).to.be.revertedWith("CH_PSZ")
        })

        it("partial close when over price limit", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 10, 1510, lowerTick, upperTick)

            // mock index price higher, so that taker can push more market price
            await mockIndexPrice(mockedPriceFeedDispatcher, "165")

            // bob swap let alice has maker position
            // after bob swap, market price: 153.36, index price: 165, spread: -7.7%
            await q2bExactInput(fixture, bob, 10)

            // alice swap
            // after alice swap, market price: 170.095, index price: 165, spread: 3.37%
            await q2bExactOutput(fixture, alice, 0.5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(
                parseEther("0.5"),
            )

            // alice partial close position, forward timestamp to bypass over price limit timestamp check
            await forwardBothTimestamps(clearingHouse, 3000)

            // set MaxTickCrossedWithinBlock so that trigger over price limit
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 250)

            // after alice partial close, market price: 165.893, index price: 165
            // spread: 0.54% (nor over price band limit)
            // positionSize remaining: 0.3815690374
            await closePosition(fixture, alice)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(
                parseEther("0.381569037390193578"),
            )
        })
    })
})
