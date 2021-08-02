import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let million
    let hundred
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let baseToken2: VirtualToken
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), 6), 0, 0, 0]
        })
    }

    function setPool2IndexPrice(price: BigNumberish) {
        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), 6), 0, 0, 0]
        })
    }

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
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

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await clearingHouse.addPool(baseToken2.address, 10000)

        // mint
        collateral.mint(alice.address, hundred)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 10, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        setPool1IndexPrice(151.373306)
        setPool2IndexPrice(151.373306)

        // mint base
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(carol).mint(baseToken2.address, parseEther("100"))
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("50000"))

        // initialize pool
        await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        await pool2.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken2.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    describe("adjustable parameter", () => {
        it.skip("setLiquidationDiscount")
        it("setLiquidationPenaltyRatio", async () => {
            await clearingHouse.setLiquidationPenaltyRatio(parseEther("0.03"))
            expect(await clearingHouse.liquidationPenaltyRatio()).to.eq(parseEther("0.03"))
        })
        it("force error, only admin", async () => {
            await expect(
                clearingHouse.connect(alice).setLiquidationPenaltyRatio(parseEther("0.03")),
            ).to.be.revertedWith("Ownable: caller is not the owner")
        })
    })

    describe("alice long ETH; price doesn't change", () => {
        it("force error, margin ratio is above the requirement", async () => {
            await clearingHouse.connect(alice).openPosition({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
            })
            await expect(clearingHouse.connect(bob).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
                "CH_EAV",
            )
        })
    })

    describe("alice long ETH, bob short", () => {
        beforeEach(async () => {
            // alice long ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.4780456375
            setPool1IndexPrice(151.478045)

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("50"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 143.0326798397
            setPool1IndexPrice(143.032679)
        })

        describe("davis liquidate alice's position", () => {
            it("closing alice's position", async () => {
                // position size: 0.588407511354640018
                // position value: 84.085192745971593683
                // pnl = 84.085192745971593683 - 90 = -5.914807254
                // account value: 10 + (-5.914807254) = 4.085192746
                // fee = 84.085192745971593683 * 0.025 = 2.1021298186
                await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
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

                // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaAvailableQuote
                // deltaAvailableQuote = 84.085192745971593683 * 0.99 (1% fee) = 83.2443408185118
                // pnl = 83.2443408185118 - 90 - 2.1021298186 = -8.8577890001
                // account value = collateral + pnl = 10 - 8.8577890001 = 1.1422109998625
                // openOrderMarginRequirement = abs(-8.8577890001) = 8.8577890001
                // free collateral = 1.1422109998625 - 8.857789000137412096 * 0.1 = 0.256432099848846695
                expect(await vault.getFreeCollateral(alice.address)).to.eq("256431")

                // liquidator gets liquidation reward
                const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
                expect(davisTokenInfo.available).to.eq("2102129818649289842")
            })
        })
    })

    // TODO copy the sheet above and make another scenario for short
    describe("alice short ETH, bob long", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice(100)

            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.2675469692
            setPool1IndexPrice(151.267546)

            // bob long ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("40"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 158.6340597836
            setPool1IndexPrice(158.634059)
        })

        it("davis liquidate alice's position", async () => {
            // position size: -0.600774259337639952
            // position value: -95.337716510326544666
            // pnl = -95.3377165103265 + 90 = -5.3032597722
            // account value: 10 + (-5.3032597722) = 4.6967402278
            // fee = 95.3377165103265 * 0.025 = 2.23834429128
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "95337716510326544666",
                    parseEther("0.600774259337639952"),
                    "2383442912758163616",
                    davis.address,
                )

            // liquidate alice's short position = long, thus dividing exchangedPositionNotional by 0.99 to get deltaAvailableQuote
            // deltaAvailableQuote = 95.337716510326544666 / 0.99 (1% fee) = 96.3007237478
            // pnl = -96.3007237478 - 2.3834429128 + 90 = -8.6841666606
            // account value = collateral + pnl = 10 - 8.6841666606 = 1.3158333394
            // openOrderMarginRequirement = abs(-8.6841666606) = 8.6841666606 (only quote debt)
            // free collateral = 1.3158333394 - 8.6841666606 * 0.1 = 0.4474166733
            expect(await vault.getFreeCollateral(alice.address)).to.eq("447416")

            // liquidator gets liquidation reward
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("2383442912758163616")
        })
    })

    describe("alice long ETH and BTC; later, ETH price goes down", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice(200)
            setPool2IndexPrice(200)

            // alice long ETH and BTC
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
            })
            // ETH price after Alice long: 151.4256717409
            setPool1IndexPrice(151.425671)

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
            })
            // BTC price after Alice long: 151.4256717409
            setPool2IndexPrice(151.425671)

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("80"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob short: 135.0801007405
            setPool1IndexPrice(135.0801)

            // bob long BTC
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob long: 151.54207047
            setPool2IndexPrice(151.54207)
        })

        it("davis liquidate alice's ETH", async () => {
            // position size of ETH: 0.294254629696195230
            // position value of ETH:  40.638764624332610211
            // pnl =  40.63876(ETH) + 44.5919558312(BTC) - 90 = -4.7625741688
            // account value: 10 + (-4.7625741688) = 5.2374258312
            // fee =  40.63876 * 0.025 = 1.015969
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
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

            // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaAvailableQuote
            // deltaAvailableQuote of ETH = 40.63876 * 0.99 (1% fee) = 40.2323724
            // ETH pnl = 40.2323724 - 90 - 1.015969115608315255 = -50.7835967156
            // account value = collateral + pnl = 10 + (40.2323724 (ETH) - 1.015969115608315255 + 44.59195 (BTC) - 90)= 3.8083532844
            // openOrderMarginRequirement = abs(-50.7835967156) ~= 50.7835967156 (only quote debt)
            // free collateral = 10 + 3.8083532844 - 50.7835967156 * 0.1 = 8.7299936128
            expect(await vault.getFreeCollateral(alice.address)).to.eq("8730003")

            // liquidator gets liquidation reward
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1015969115608315255")
        })

        it("davis liquidate alice's BTC position even she has profit in ETH market", async () => {
            // position size of BTC: 0.294254629696195230
            // position value of BTC:  44.591955831233061486
            // pnl =  40.63876(ETH) + 44.591955831233(BTC) - 90 = -4.76256667585
            // account value: 10 + (-4.76256667585) = 5.2374258312
            // fee =  44.584241981393002740 * 0.025 = 1.1146060495
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address))
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
            // ETH position value = ETH size * indexPrice = 0.294254629696195230 * 135.0801 = 39.7479448048

            // liquidate alice's long position = short, thus multiplying exchangedPositionNotional by 0.99 to get deltaAvailableQuote
            // deltaAvailableQuote of BTC = 44.58424198139300 * 0.99 (1% fee) = 44.1383995616
            // account value = collateral + pnl = 20 + (39.7479448048(ETH) + 44.1383995616(BTC) - 90 - 1.1146060495) = 12.7717383169
            // (totalBaseDebt + totalQuoteDebt) * imRatio = (90 - 44.1383995616 + 1.1146060495) * 0.1 = 4.6976206488
            // freeCollateral = 12.7717383169 - 4.6976206488 = 8.0741176681
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("8.074117", collateralDecimals))

            // liquidator gets liquidation reward
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1114606049534825068")
        })
    })

    describe("alice short ETH and BTC; later, ETH price goes down", () => {
        beforeEach(async () => {
            // makes alice able to trade
            setPool1IndexPrice(100)
            setPool2IndexPrice(100)

            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice short, 151.3198881742
            setPool1IndexPrice(151.319888)

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("45"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice short, 151.3198881742
            setPool2IndexPrice(151.319888)

            // bob long 80 ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("80"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 166.6150230501
            setPool1IndexPrice(166.615023)

            // bob short BTC with 100 quote
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob short, 151.20121364648824
            setPool2IndexPrice(151.201213)
        })

        it("davis liquidate alice's ETH", async () => {
            // position size of ETH: -0.300334113234575750
            // position value of ETH: -50.040175199
            // pnl = -50.040175199 +(-45.41088242) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 50.040175199 * 0.025 = 1.25100438
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
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
            // const balance = await vault.balanceOf(alice.address)
            // const accountValue = await clearingHouse.getAccountValue(alice.address)
            // const getTotalOpenOrderMarginRequirement = await clearingHouse.getTotalOpenOrderMarginRequirement(
            //     alice.address,
            // )
            // console.log(`balance=${formatEther(balance.toString())}`)
            // console.log(`accountValue=${formatEther(accountValue.toString())}`)
            // console.log(
            //     `getTotalOpenOrderMarginRequirement=${formatEther(getTotalOpenOrderMarginRequirement.toString())}`,
            // )
            // // accountValue = collateral + totalMarketPnl
            // // totalMarketPnl = netQuoteBalance + totalPosValue
            // const getTotalMarketPnl = await clearingHouse.getTotalMarketPnl(alice.address)
            // console.log(`getTotalMarketPnl=${formatEther(getTotalMarketPnl.toString())}`)
            // // netQuoteBalance = quote.ava - quote.debt + quoteInPool
            // const getCostBasis = await clearingHouse.getCostBasis(alice.address)
            // console.log(`getCostBasis=${formatEther(getCostBasis.toString())}`)
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
            // netQuote = quoteBefore - liquidatedPosition(exl CH fee) - liquidationPenalty
            // 90 - 50.049442662484937695/0.99 - 1.251236066562123442 = 38.1937713451
            // totalPosValue = positionSize * indexPrice = -0.300334113234575750 * 151.201213 = -45.4108822263
            // totalMarketPnl = netQuoteBalance + totalPosValue =  38.1937713451 - 45.4108822263 = -7.2171108812
            // accountValue = collateral + totalMarketPnl = 20 - 7.2171108812 = 12.7828891188
            // getTotalOpenOrderMarginRequirement = (totalBaseDebt + totalQuoteDebt) * imRatio = 4.54108822263
            // freeCollateral =12.7828891188 - 4.54108822263 = 8.2418008962
            // (actual) 12.782889118722045683-4.541088222634720694 = 8.241800896087324989
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("8.241800", collateralDecimals))

            // liquidator gets liquidation reward
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1251236066562123442")
        })

        it("davis liquidate alice's BTC even she has profit in ETH market", async () => {
            // position size of BTC: -0.300334113234575750
            // position value of BTC: -45.410882420509684093
            // pnl = -50.040175199 +(-45.4188940109116) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 45.4188940 * 0.025 = 1.135472350272790574
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address))
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
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("7.942663", collateralDecimals))

            // liquidator gets liquidation reward
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1135472350272790574")
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
