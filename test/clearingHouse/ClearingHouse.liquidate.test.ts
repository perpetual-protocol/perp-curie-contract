import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let million
    let hundred
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number
    const oracleDecimals = 6
    const blockTimeStamp = 1

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    function setPool2IndexPrice(price: BigNumberish) {
        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())

        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        clearingHouseConfig = _clearingHouseFixture.clearingHouseConfig
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance as TestAccountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        pool2 = _clearingHouseFixture.pool2
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2
        collateralDecimals = await collateral.decimals()

        million = parseUnits("1000000", collateralDecimals)
        hundred = parseUnits("100", collateralDecimals)

        // initialize ETH pool
        await initAndAddPool(
            _clearingHouseFixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.3733069", "1"),
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        // initialize BTC pool
        await initAndAddPool(
            _clearingHouseFixture,
            pool2,
            baseToken2.address,
            encodePriceSqrt("151.3733069", "1"),
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        // mint
        collateral.mint(alice.address, hundred)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 10, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken2.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        await syncIndexToMarketPrice(mockedBaseAggregator, pool)
        await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

        // set blockTimestamp
        await clearingHouse.setBlockTimestamp(blockTimeStamp)
    })

    it("force error, zero address should fail", async () => {
        await expect(
            clearingHouse.connect(bob)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
        ).to.be.revertedWith("CH_EAV")
    })

    describe("alice long ETH; price doesn't change", () => {
        it("force error, margin ratio is above the requirement", async () => {
            await clearingHouse.connect(alice).openPosition({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            await expect(
                clearingHouse.connect(bob)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).to.be.revertedWith("CH_EAV")
        })
    })

    describe("alice long ETH, bob short", () => {
        beforeEach(async () => {
            // alice long ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Alice swap : 151.4780456375
            // setPool1IndexPrice(151.4780456375)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("50"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after bob swap : 143.0326798397
            // setPool1IndexPrice(143.0326798397)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)

            // set MaxTickCrossedWithinBlock to enable price checking before/after swap
            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        })

        it("davis liquidate alice's long position", async () => {
            // position size: 0.588407511354640018
            // position value: 84.085192745971593683
            // pnl = 84.085192745971593683 - 90 = -5.914807254
            // account value: 10 + (-5.914807254) = 4.085192746
            // fee = 84.085192745971593683 * 0.025 = 2.1021298186
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "84085192745971593683",
                    parseEther("0.588407511354640018"),
                    "2102129818649289842",
                    davis.address,
                )
            // price after liq. 142.8549872
            setPool1IndexPrice(142.854987)

            // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaQuote
            // deltaQuote = 84.085192745971593683 * 0.99 (1% fee) = 83.2443408185118
            // pnl = 83.2443408185118 - 90 - 2.1021298186 = -8.8577890001
            // account value = collateral + pnl = 10 - 8.8577890001 = 1.1422109998625
            // openOrderMarginRequirement = 0
            // free collateral = 1.142211 - 0 = 1.142211
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("1.142211", 6))

            // liquidator gets liquidation reward
            const davisPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davisPnl[0]).to.eq("2102129818649289842")
        })

        it("partial closes due to not enough liquidity", async () => {
            // maker remove 99.99% liquidity
            const liquidity = (await orderBook.getOpenOrder(carol.address, baseToken.address, 49000, 51400)).liquidity
            await clearingHouse.connect(carol).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 49000,
                upperTick: 51400,
                liquidity: liquidity.sub(liquidity.div(1000)),
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // first liquidation
            await clearingHouse
                .connect(davis)
                ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0)

            // current tick was pushed to MIN_TICK because all liquidity were depleted
            const afterLiquidateTick = (await pool.slot0()).tick
            expect(afterLiquidateTick).to.be.deep.eq(-887272)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 2)

            // second liquidation would fail because no liquidity left
            // revert 'SPL' from @uniswap/v3-core/contracts/UniswapV3Pool.sol#L612
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).revertedWith("SPL")
        })

        it("partial closes due to bad price", async () => {
            // maker remove all liquidity
            await clearingHouse.connect(carol).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 49000,
                upperTick: 51400,
                liquidity: (await orderBook.getOpenOrder(carol.address, baseToken.address, 49000, 51400)).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // maker add enough liquidity in bad price
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("15000"),
                lowerTick: 0,
                upperTick: 200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // set davis as backstop liquidity provider
            await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)

            // first liquidation should be partial because price movement exceeds the limit
            await clearingHouse
                .connect(davis)
                ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0)

            // alice has partial close when first liquidity
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("0.441305633515980014"),
            )
            // tick should be pushed to the edge of the new liquidity since there's nothing left elsewhere
            expect((await pool.slot0()).tick).to.be.deep.eq(199)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 2)

            // second liquidation should be liquidate all positionSize since the liquidity here is plenty
            await clearingHouse
                .connect(davis)
                ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.deep.eq("0")
        })

        it("fails to close due to no liquidity", async () => {
            // maker remove all liquidity
            await clearingHouse.connect(carol).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 49000,
                upperTick: 51400,
                liquidity: (await orderBook.getOpenOrder(carol.address, baseToken.address, 49000, 51400)).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).revertedWith("CH_F0S")
        })
    })

    describe("alice short ETH, bob long", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice(100)

            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Alice swap : 151.2675469692
            // setPool1IndexPrice(151.2675469692)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // bob long ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("40"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after bob swap : 158.6340597836
            // setPool1IndexPrice(158.6340597836)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)

            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        })

        it("davis liquidate alice's short position", async () => {
            // position size: -0.600774259337639952
            // position value: -95.337716510326544666
            // pnl = -95.3377165103265 + 90 = -5.3032597722
            // account value: 10 + (-5.3032597722) = 4.6967402278
            // fee = 95.3377165103265 * 0.025 = 2.23834429128
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "95337716510326544666",
                    parseEther("0.600774259337639952"),
                    "2383442912758163616",
                    davis.address,
                )

            // liquidate alice's short position = long, thus dividing exchangedPositionNotional by 0.99 to get deltaQuote
            // deltaQuote = 95.337716510326544666 / 0.99 (1% fee) = 96.3007237478
            // pnl = -96.3007237478 - 2.3834429128 + 90 = -8.6841666606
            // account value = collateral + pnl = 10 - 8.6841666606 = 1.3158333394
            // openOrderMarginRequirement = 0
            // free collateral = 1.315834 - 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("1.315834", 6))

            // liquidator gets liquidation reward
            const davidPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davidPnl[0]).to.eq("2383442912758163616")
        })

        it("davis liquidate alice's short position with oppositeAmountBound", async () => {
            // position size: -0.600774259337639952
            // position value: -95.337716510326544666
            // pnl = -95.3377165103265 + 90 = -5.3032597722
            // account value: 10 + (-5.3032597722) = 4.6967402278
            // fee = 95.3377165103265 * 0.025 = 2.23834429128

            // quote 95.337716510326544666 / 0.99 = 96.300723747804590572
            // if oppositeAmountBound == 96.3007237477, slippage check will fail as alice is not willing to pay more than 96.3007237477 to close her short position
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](
                        alice.address,
                        baseToken.address,
                        parseEther("96.3007237477"),
                    ),
            ).to.be.revertedWith("CH_TMRL")

            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](
                        alice.address,
                        baseToken.address,
                        parseEther("96.30072374781"),
                    ),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "95337716510326544666",
                    parseEther("0.600774259337639952"),
                    "2383442912758163616",
                    davis.address,
                )
        })
    })

    describe("alice long ETH and BTC; later, ETH price goes down", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice("151.373307")
            setPool2IndexPrice("151.373307")

            // alice long ETH and BTC
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // ETH price after Alice long: 151.4256717409
            // setPool1IndexPrice(151.4256717409)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // BTC price after Alice long: 151.4256717409
            // setPool2IndexPrice(151.425671)
            await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("80"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Bob short: 138.130291
            // setPool1IndexPrice(138.130291)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // bob long BTC
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Bob long: 151.54207047
            // setPool2IndexPrice(151.54207047)
            await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)

            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        })

        it("davis liquidate alice's ETH", async () => {
            // position size of ETH: 0.294254629696195230
            // position value of ETH:  40.638764624332610211
            // pnl =  40.63876(ETH) + 44.5919558312(BTC) - 90 = -4.7625741688
            // account value: 10 + (-4.7625741688) = 5.2374258312
            // fee =  40.63876 * 0.025 = 1.015969
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "40638764624332610211", // 40.63876
                    "294254629696195230", // 0.29
                    "1015969115608315255", // 1.015969
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)

            // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaQuote
            // deltaQuote of ETH = 40.63876 * 0.99 (1% fee) = 40.2323724
            // realizedPnl = 40.2323724 - 45 = -4.7676276
            // remain quoteDebt = 90 - 45 (deltaQuote - realizedPnl) = 45
            // collateral = deposit + realizedPnl + penaltyFee = 20 + -4.7676276 - 1.015969 = 14.2164034
            // account value = collateral + pnl = 14.2164034 + (44.59195 (BTC) - 45)= 13.8083534
            // openOrderMarginRequirement = 45 (quote debt only)
            // free collateral = min(14.2164034, 13.8083534) -  45 * 0.1 =9.3083
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("9.308364", 6))

            // liquidator gets liquidation reward
            const davisPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davisPnl[0]).to.eq("1015969115608315255")
        })

        it("davis liquidate alice's ETH with oppositeAmountBound", async () => {
            // position size of ETH: 0.294254629696195230
            // position value of ETH:  40.638764624332610211
            // pnl =  40.63876(ETH) + 44.5919558312(BTC) - 90 = -4.7625741688
            // account value: 10 + (-4.7625741688) = 5.2374258312

            // quote 40.638764624332610211 * 0.99 = 40.232376978089284108
            // if oppositeAmountBound == 40.2323769781, slippage check will fail as alice is not willing to accept less than 40.2323769781 to close her short position
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](
                        alice.address,
                        baseToken.address,
                        parseEther("40.2323769781"),
                    ),
            ).to.be.revertedWith("CH_TLRS")

            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](
                        alice.address,
                        baseToken.address,
                        parseEther("40.232376978"),
                    ),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "40638764624332610211", // 40.63876
                    "294254629696195230", // 0.29
                    "1015969115608315255", // 1.015969
                    davis.address,
                )
        })

        it("davis liquidate alice's BTC position even her BTC position is safe", async () => {
            // position size of BTC: 0.294254629696195230
            // position value of BTC:  44.591955831233061486
            // pnl =  40.63876(ETH) + 44.591955831233(BTC) - 90 = -4.76256667585
            // account value: 10 + (-4.76256667585) = 5.2374258312
            // fee =  44.584241981393002740 * 0.025 = 1.1146060495
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken2.address,
                    "44584241981393002740", //  44.584
                    "294254629696195230", // 0.29
                    "1114606049534825068", //1.1146
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)

            // freeCollateral = min(collateral, accountValue) - (totalBaseDebtValue + totalQuoteDebtValue) * imRatio
            // ETH position value = ETH size * indexPrice = 0.294254629696195230 * 138.130291 = 40.645477628

            // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaQuote
            // deltaQuote of BTC = 44.58424198139300 * 0.99 (1% fee) = 44.1383995616
            // realizedPnl = 44.1383995616 - 45 - 1.1146 = -1.9762004384
            // collateral = 20 -1.9762004384 = 18.0237995616
            // account value = collateral + pnl = 18.0237995616 + (40.645477628(ETH) - 45) = 13.6692771896
            // (totalBaseDebt + totalQuoteDebt) * imRatio = 45 * 0.1 = 4.5
            // freeCollateral = 13.6692771896 - 4.5 = 9.1692771896
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("9.169272", collateralDecimals))

            // liquidator gets liquidation reward
            const davisPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davisPnl[0]).to.eq("1114606049534825068")
        })
    })

    describe("alice short ETH and BTC; later, ETH up BTC down", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice("151")
            setPool2IndexPrice("151")

            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Alice short, 151.3198881742
            // setPool1IndexPrice(151.319888)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Alice short, 151.3198881742
            // setPool2IndexPrice(151.319888)
            await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

            // bob long 80 ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("80"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after bob swap : 166.6150230501
            // setPool1IndexPrice(166.615023)
            await syncIndexToMarketPrice(mockedBaseAggregator, pool)

            // bob short BTC with 100 quote
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after Bob short, 151.20121364648824
            // setPool2IndexPrice(151.201213)
            await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)

            // set MaxTickCrossedWithinBlock to enable price checking before/after swap
            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        })

        it("davis liquidate alice's ETH", async () => {
            // position size of ETH: -0.300334113234575750
            // position value of ETH: -50.040175199
            // pnl = -50.040175199 +(-45.41088242) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 50.040175199 * 0.025 = 1.25100438
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "50049442662484937695",
                    "300334113234575750",
                    "1251236066562123442",
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)

            // since the result has a bit rounding diff (8.2418008962 & 8.241800896087324989)
            // so i leave every unit of numbers below to help if someone want to audit the numbers
            //
            // const balance = await vault.getBalance(alice.address)
            // const accountValue = await clearingHouse.getAccountValue(alice.address)
            // const getTotalOpenOrderMarginRequirement = await clearingHouse.getTotalOpenOrderMarginRequirement(
            //     alice.address,
            // )
            // console.log(`balance=${formatUnits(balance.toString(), 6)}`)
            // console.log(`accountValue=${formatUnits(accountValue.toString(), 6)}`)
            // console.log(
            //     `getTotalOpenOrderMarginRequirement=${formatEther(getTotalOpenOrderMarginRequirement.toString())}`,
            // )
            // accountValue = collateral + totalMarketPnl
            // totalMarketPnl = netQuoteBalance + totalPosValue
            // const getTotalUnrealizedPnl = await accountBalance.getPnlAndPendingFee(alice.address)
            // console.log(`getTotalUnrealizedPnl=${formatEther(getPnlAndPendingFee.toString())}`)
            // // netQuoteBalance = quote.ava - quote.debt + quoteInPool
            // const netQuoteBalance = await accountBalance.getNetQuoteBalanceAndPendingFee(alice.address)
            // console.log(`netQuoteBalance=${formatEther(netQuoteBalance.toString())}`)
            // {
            //     const tokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            //     console.log(`quote=${formatEther(tokenInfo.available.toString())}`)
            //     console.log(`quote.debt=${formatEther(tokenInfo.debt.toString())}`)
            // }
            // {
            //     const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
            //     console.log(`base=${formatEther(tokenInfo.available.toString())}`)
            //     console.log(`base.debt=${formatEther(tokenInfo.debt.toString())}`)
            // }
            // {
            //     const tokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken2.address)
            //     console.log(`base2=${formatEther(tokenInfo.available.toString())}`)
            //     console.log(`base2.debt=${formatEther(tokenInfo.debt.toString())}`)
            // }
            // END

            // formula: freeCollateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // requiredNotionalForEth = 50.049442662484937695/0.99 = 50.5549925884
            // realizedPnl = -50.5549925884 + 45 = -5.5549925884
            // penaltyFee = 1.251236066562123442
            // collateral = 20 + -5.5549925884 - 1.251236066562123442 = 13.193771345
            // BTC notional = positionSize * indexPrice = -0.300334113234575750 * 151.201213 = -45.4108822263
            // totalMarketPnl = 45 - 45.4108822263 (BTC) = -0.4108822263
            // accountValue = 13.193771345 + -0.4108822263 = 12.7828891187
            // totalOpenOrderMarginRequirement = 45.4108822263 * 0.1 = 4.5410882420509684093
            // freeCollateral = 12.7828891187 - 4.5410882420509684093 = 8.2418
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("8.241802", collateralDecimals))

            // liquidator gets liquidation reward
            const davisPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davisPnl[0]).to.eq("1251236066562123442")
        })

        it("davis liquidate alice's BTC even she has profit in ETH market", async () => {
            // position size of BTC: -0.300334113234575750
            // position value of BTC: -45.410882420509684093
            // pnl = -50.040175199 +(-45.4188940109116) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 45.4188940 * 0.025 = 1.135472350272790574
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken2.address,
                    "45418894010911622979",
                    "300334113234575750",
                    "1135472350272790574",
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)

            // formula: freeCollateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // netQuote = quoteBefore - liquidatedPosition(exl CH fee) - liquidationPenalty
            // 90 - 45.418894010911622979/0.99 - 1.135472350272790574 = 42.9868569316
            // totalPosValue = positionSize * indexPrice = -0.300334113234575750 * 166.615023 = -50.0401751843
            // totalMarketPnl = netQuoteBalance + totalPosValue =  42.9868569316 + -50.0401751843= -7.0533182527
            // accountValue = collateral + totalMarketPnl = 20 + -7.0533182527 = 12.9466817473
            // getTotalOpenOrderMarginRequirement = (totalBaseDebt + totalQuoteDebt) * imRatio = 50.0401751843 * 0.1
            // freeCollateral = 12.9466817473 - 5.00401751843 = 7.9426642289
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("7.942665", collateralDecimals))

            // liquidator gets liquidation reward
            const davisPnl = await accountBalance.getPnlAndPendingFee(davis.address)
            expect(davisPnl[0]).to.eq("1135472350272790574")
        })
    })

    describe.skip("V2 liquidator takes trader's position", () => {
        describe("davis takeover the position", () => {
            it("swap davis's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
            it("close alice's position")
            it("force error, davis's quote balance is insufficient")
        })
        it("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it("liquidate alice's position partially by davis")
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log(`timestamp (before liquidation): ${(await ethers.provider.getBlock("latest")).timestamp}`)
// console.log(`mark twap: ${formatEther(parseEther((await clearingHouse.getMarkTwapX96(baseToken.address)).toString()).div(BigNumber.from(2).pow(96)))}`)
// console.log(`index price: ${formatEther(await clearingHouse.getIndexPrice(baseToken.address))}`)
// console.log(`position size: ${formatEther(await accountBalance.getTotalPositionSize(alice.address, baseToken.address))}`)
// console.log(`getAllPendingFundingPayment: ${formatEther(await clearingHouse.getAllPendingFundingPayment(alice.address))}`)
// // === useful console.log for verifying stats ===
