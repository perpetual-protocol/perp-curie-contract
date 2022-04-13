import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { QuoteToken } from "../../typechain/QuoteToken"
import { b2qExactInput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse funding", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(false))
        clearingHouse = fixture.clearingHouse as ClearingHouse
        clearingHouseConfig = fixture.clearingHouseConfig
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("154.4310961", "1"), // price at 50400 == 154.4310961
            10000,
            1000,
        )

        // alice add long limit order
        await collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)

        await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)

        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
    })

    describe("# getPendingFundingPayment", () => {
        describe("one maker and one trader", async () => {
            beforeEach(async () => {
                // note that alice opens an order before we have a meaningful index price value, this is fine (TM)
                // because the very first funding settlement on the market only records the timestamp and
                // does not calculate or change anything else
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                // bob short
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.099"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // alice:
                //   base.liquidity = 0
                //   quote.liquidity = 100
                // bob:
                //   base.available = 2 - 0.099 = 1.901
                //   base.debt = 2
                //   quote.available = 15.1128025359
                //   quote.debt = 0
                // mark price should be 153.9623330511 (tick ~= 50369)
            })

            it("no funding payment when it's still the same block as swapping", async () => {
                // bob's position size = 0
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
            })

            it("no funding payment when there is no position/ no such a trader", async () => {
                // carol's position size = 0
                expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).eq(0)
            })

            it("force error, base token does not exist", async () => {
                await expect(exchange.getPendingFundingPayment(alice.address, quoteToken.address)).to.be.reverted
            })
        })

        describe("one maker provides order in range and another maker provides order above current price", async () => {
            beforeEach(async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })
                // alice provides liquidity with the range inside
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("10"),
                    quote: parseEther("10000"),
                    lowerTick: 50200,
                    upperTick: 50600,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                // settleFunding:
                // markTwap: 154.431096099999999999
                // indexTwap: 150.953124
                // fundingGrowthGlobal.twPremium: 0
                // fundingGrowthGlobal.twPremiumDivBySqrtPrice: 0

                // carol provides liquidity with range right
                await clearingHouse.connect(carol).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("10"),
                    quote: parseEther("0"),
                    lowerTick: 51000,
                    upperTick: 51200,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                // settleFunding:
                // markTwap: 154.431096099999999999
                // indexTwap: 150.953124
                // fundingGrowthGlobal.twPremium: 3.4779721 * 1(sec)
                // fundingGrowthGlobal.twPremiumDivBySqrtPrice: 3.4779721 / sqrt(154.431096099999999999) = 0.27987152667
                // liquidity: 12870245414941510880707
                // tick init:
                // tick[51000].twPremium = 0
                // tick[51000].twPremiumDivBySqrtPrice = 0
                // tick[51200].twPremium = 0
                // tick[51200].twPremiumDivBySqrtPrice = 0
            })

            it("trader short, no funding payment for the maker providing the order above current price", async () => {
                // bob short
                await expect(
                    clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.emit(exchange, "FundingUpdated")
                // settleFunding:
                // markTwap: 154.431096099999999999
                // indexTwap: 150.953124
                // fundingGrowthGlobal.twPremium: 3.4779721 + 3.4779721 * 1(sec) = 6.9559442
                // fundingGrowthGlobal.twPremiumDivBySqrtPrice: 0.27987152667 + (3.4779721 / sqrt(154.431096099999999999)) = 0.55974305334

                forward(360)

                // carol should get zero funding payment:
                // currentFundingGrowthGlobal:
                // current tick: 50380
                // markTwap: 154.122557956125310730
                // indexTwap: 150.953124
                // deltaPremium: (154.122557956125310730-150.953124) * 360 = 1140.99622421
                // fundingGrowthGlobal.twPremium: 6.9559442 + 1140.99622421 = 1147.95216841
                // fundingGrowthGlobal.twPremiumDivBySqrtPrice: 0.55974305334 + (1140.99622421 / sqrt(154.122557956125310730)) = 92.467274834
                // tick[51000].twPremiumGrowthOutside = 0
                // tick[51000].twPremiumDivBySqrtPriceGrowthOutside = 0
                // tick[51200].twPremiumGrowthOutside = 0
                // tick[51200].twPremiumDivBySqrtPriceGrowthOutside = 0
                // tick[51000].twPremiumGrowthBelow = (1147.95216841-0) = 1147.95216841
                // tick[51000].twPremiumDivBySqrtPriceGrowthBelow = (92.467274834-0) = 92.467274834
                // tick[51000-51200].twPremiumGrowthInside = 1147.95216841 - 1147.95216841 - 0 = 0
                // tick[51000-51200].twPremiumDivBySqrtPriceGrowthInside = 92.467274834 - 92.467274834 - 0 = 0
                // account.lastTwPremium: 3.4779721
                // account.lastTwPremiumDivBySqrtPrice: 0.27987152667
                // funding payment from liquidity: (funding payment below range + funding payment in range) / 86400
                //                               = (10 * (1147.95216841-3.4779721)) + (12870.245414941510880707) * ((0-0)-(0/sqrt(1.000.1^51200-0)))
                //                               = 11444.7419631 / 86400 = 0.13246229124
                // funding payment from balance = -10 * (1147.95216841-3.4779721) / 86400 = -0.13246229124
                // funding payment = 0.13246229124 + (- 0.13246229124) = 0
                expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(parseEther("0"))

                // carol remove liquidity
                await expect(
                    clearingHouse.connect(carol).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 51000,
                        upperTick: 51200,
                        liquidity: "12870245414941510880707",
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.emit(exchange, "FundingUpdated")

                // should settle funding payment and add into owedRealizePnl
                // owedRealizePnl should be 0
                const owedRealizePnl = (await accountBalance.getPnlAndPendingFee(carol.address))[0]
                expect(owedRealizePnl).to.eq(parseEther("0"))
                expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(parseEther("0"))
            })
        })
    })

    describe("# _settleFundingAndUpdateFundingGrowth", () => {
        it("markTwap & indexTwap are not zero in the first tx of the market", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150.953124", 6), 0, 0, 0]
            })
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(exchange, "FundingUpdated")
                .withArgs(baseToken.address, parseEther("154.431096099999999999"), parseEther("150.953124"))
        })

        describe("one maker with one order, multiple takers", () => {
            beforeEach(async () => {
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
            })

            // placing this test here as it will be executed first due to the structure
            // twap is introduced by not always setting forward() with values > twapInterval = 900 (default)
            // can notice that markTwaps in this case are different from those in "two takers; first positive then negative funding"
            it("with twap; two takers; positive, negative then positive funding", async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })

                // bob's position 0 -> -0.099
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.099"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                await forward(300)

                // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 300 / 86400 = -0.001031250282
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("-0.001031250281599379"),
                )

                // carol's position 0 -> 0.09
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("0.09"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // alice's funding payment shouldn't change after carol swaps
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // -(-0.099 * (153.9531248192 - 150.953124) * 301 / 86400) = 0.001034687783
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.001034687782538044"),
                )

                await forward(450)

                // set index price for a negative funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("156.953124", 6), 0, 0, 0]
                })

                // notice that markTwap here is not 154.3847760162 as in "two takers; first positive then negative funding", though having the same amount swapped
                // bob's funding payment = -0.099 * ((153.9531248192 - 150.953124) * 301 + (154.1996346489 - 156.953124) * 450) / 86400 = 0.0003850801641
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.000385080164122650"),
                )
                // carol's funding payment = 0.09 * (154.1996346489 - 156.953124) * 450 / 86400 = -0.001290698133
                expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                    parseEther("-0.001290698133327903"),
                )
                // alice's funding payment = -(sum of takers' funding payments) = -(0.0003850801641 + -0.001290698133) = 0.0009056179689
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.000905617969205253"),
                )

                // bob swaps to trigger funding update & funding-related prices emission
                // -0.099 * ((153.9531248192 - 150.953124) * 301 + (154.1996346489 - 156.953124) * 451) / 86400 = 0.000388235204
                const tx = await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.0000000001"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                await expect(tx)
                    .to.emit(clearingHouse, "FundingPaymentSettled")
                    .withArgs(bob.address, baseToken.address, parseEther("0.000388235204004118"))
                await expect(tx)
                    .to.emit(exchange, "FundingUpdated")
                    .withArgs(baseToken.address, parseEther("154.199634648900471640"), parseEther("156.953124"))

                // note that bob will settle his pending funding payment here
                await forward(250)

                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("152.953124", 6), 0, 0, 0]
                })

                // bob's funding payment = -0.099 * (154.2767498877 - 152.953124) * 250 / 86400 = -0.0003791636657
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("-0.000379163666139115"),
                )
                // carol's funding payment = 0.09 * ((154.1996346489 - 156.953124) * 451 + (154.2767498877 - 152.953124) * 250) / 86400 = -0.0009488721098
                expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                    parseEther("-0.000948872109805491"),
                )
                // alice's funding payment = -(sum of takers' funding payments) = 0.0009056179689 + -(-0.0003791636657 + 0.09 * (154.2767498877 - 152.953124) * 250 / 86400) = 0.000940087393
                // there is minor imprecision thx to hardhat and choose to ignore it in this case
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.000939800571940488"),
                )
            })

            describe("without twap/ prices are consistent in the twapInterval", () => {
                // Basic example
                it("one taker swaps once; positive funding", async () => {
                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    await forward(3600)

                    // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 3600 / 86400 = -0.01237500338
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.012375003379192556"),
                    )
                    // alice's funding payment = -(bob's funding payment)
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.012375003379192556"),
                    )

                    await forward(3600)

                    // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 7200 / 86400 = -0.02475000676
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.024750006758385112"),
                    )
                    // alice's funding payment = -(bob's funding payment)
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.024750006758385112"),
                    )

                    const [owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(bob.address)

                    // swaps arbitrary amount to trigger funding settlement & funding-related prices emission
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * (153.9531248192 - 150.953124) * 7201 / 86400 = -0.02475344426
                    const tx = await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.0000000001"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    await expect(tx)
                        .to.emit(clearingHouse, "FundingPaymentSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("-0.024753444259323776"))
                    await expect(tx)
                        .to.emit(exchange, "FundingUpdated")
                        .withArgs(baseToken.address, parseEther("153.953124819198195396"), parseEther("150.953124"))

                    // verify owedRealizedPnl
                    const [owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(bob.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.024753444259323776"))
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(0)
                })

                it("one taker swaps twice; add liquidity in between; negative funding", async () => {
                    // set index price for a negative funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("156.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    // the following check tends to fail the test due to unknown reason, thus commenting out for now
                    // await expect(
                    //     clearingHouse.connect(alice).addLiquidity({
                    //         baseToken: baseToken.address,
                    //         base: parseEther("2"),
                    //         quote: parseEther("100"),
                    //         lowerTick: 50200,
                    //         upperTick: 50400,
                    //         minBase: 0,
                    //         minQuote: 0,
                    //         useTakerBalance: false,
                    //         deadline: ethers.constants.MaxUint256,
                    //     }),
                    // )
                    //     .to.emit(clearingHouse, "FundingPaymentSettled")
                    //     .withArgs(alice.address, baseToken.address, parseEther("-0.000003426947962258"))

                    // alice add arbitrarily more liquidity. This should not impact alice's position size
                    // note that as the twapInterval/time span here is merely 1 second, markTwap is substituted by mark price
                    // 0.099 * (153.9623330511 - 156.953124) * 1 / 86400 = -0.000003426947962
                    await clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("2"),
                        quote: parseEther("100"),
                        lowerTick: 50200,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    })

                    await forward(3600)

                    // bob's funding payment = -0.099 * ((153.9623330511 - 156.953124) * 1 + (153.9531248192 - 156.953124) * 3600) / 86400 = 0.01237842357
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.012378423568769702"),
                    )
                    // alice's funding payment = 0.099 * (153.9531248192 - 156.953124) * 3600 / 86400 = -0.01237499662
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.012374996620807443"),
                    )

                    // bob's position -0.099 -> -0.2
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * ((153.9623330511 - 156.953124) * 1 + (153.9531248192 - 156.953124) * 3601) / 86400 = 0.01238186107
                    const tx = await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.101"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    await expect(tx)
                        .to.emit(clearingHouse, "FundingPaymentSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("0.012381861067831037"))
                    await expect(tx)
                        .to.emit(exchange, "FundingUpdated")
                        .withArgs(baseToken.address, parseEther("153.953124819198195396"), parseEther("156.953124"))

                    await forward(3600)

                    // bob's funding payment = -0.2 * (153.7377520091 - 156.953124) * 3600 / 86400 = 0.02679476659
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.026794766591206201"),
                    )
                    // alice's pending funding payment =
                    //    -(bob's settled funding payment + bob's pending funding payment - alice's settled funding payment)
                    // -(0.01238187162 + 0.02679476659) - -0.000003437499061 = -0.03917320071
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.039173200711074980"),
                    )
                })

                it("two takers; first positive then negative funding", async () => {
                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    await forward(3600)

                    // carol's position 0 -> 0.09
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: ethers.constants.MaxUint256,
                        amount: parseEther("0.09"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    // alice's funding payment shouldn't change after carol swaps
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -(-0.099 * (153.9531248192 - 150.953124) * 3601 / 86400) = 0.01237844088
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.012378440880131220"),
                    )

                    await forward(3600)

                    // set index price for a negative funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("156.953124", 6), 0, 0, 0]
                    })

                    // bob's funding payment = -0.099 * ((153.9531248192 - 150.953124) * 3601 + (154.3847760162 - 156.953124) * 3600) / 86400 = -0.001784005447
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.001784005446830714"),
                    )
                    // carol's funding payment = 0.09 * (154.3847760162 - 156.953124) * 3600 / 86400 = -0.009631304939
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.009631304939364096"),
                    )
                    // alice's funding payment = -(sum of takers' funding payments) = -(-0.001784005447 + -0.009631304939) = 0.01141531039
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.011415310386194810"),
                    )

                    // settle bob's funding
                    let [owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(bob.address)

                    // swaps arbitrary amount to trigger funding settlement
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * ((153.9531248192 - 150.953124) * 3601 + (154.3847760162 - 156.953124) * 3601) / 86400 = -0.001781062548
                    await expect(
                        clearingHouse.connect(bob).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            oppositeAmountBound: 0,
                            amount: parseEther("0.0000000001"),
                            sqrtPriceLimitX96: 0,
                            deadline: ethers.constants.MaxUint256,
                            referralCode: ethers.constants.HashZero,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingPaymentSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("-0.001781062548099241"))

                    // verify owedRealizedPnl
                    let [owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(bob.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.001781062548099241"))
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(0)

                    // ----------------------
                    // settle carol's funding
                    ;[owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(carol.address)

                    // the following check tends to fail the test due to unknown reason, thus commenting out for now
                    // await expect(
                    //     clearingHouse.connect(carol).openPosition({
                    //         baseToken: baseToken.address,
                    //         isBaseToQuote: false,
                    //         isExactInput: false,
                    //         oppositeAmountBound: ethers.constants.MaxUint256,
                    //         amount: parseEther("0.0000000001"),
                    //         sqrtPriceLimitX96: 0,
                    //         deadline: ethers.constants.MaxUint256,
                    //         referralCode: ethers.constants.HashZero,
                    //     }),
                    // )
                    //     .to.emit(clearingHouse, "FundingPaymentSettled")
                    //     .withArgs(carol.address, baseToken.address, parseEther("-0.009636655664330410"))

                    // swaps arbitrary amount to trigger funding settlement
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // 0.09 * (154.3847760162 - 156.953124) * 3602 / 86400 = -0.009636655664
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: ethers.constants.MaxUint256,
                        amount: parseEther("0.0000000001"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    // verify owedRealizedPnl
                    ;[owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(carol.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.009636655664330410"))
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)
                })
            })
        })

        describe("two orders with different ranges, one taker; positive funding", () => {
            beforeEach(async () => {
                // note that alice opens an order before we have a meaningful index price value, this is fine (TM)
                // because the very first funding settlement on the market only records the timestamp and
                // does not calculate or change anything else
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })
            })

            it("one maker; reduce one order and then remove both", async () => {
                //           |-----| alice range #0
                //      |----------| alice range #1
                //   -----------------------------> p
                //                 50400             (154.4310960807)
                //           50200                   (151.3733068587)
                //     50000                         (148.3760629231)
                //         <--------x
                //         end      current

                // add opens another order with larger range
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                // bob's position 0 -> -1.2
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1.2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                await forward(3600)

                // bob's funding payment = -1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = 0.07823581971
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.078235819711065467"),
                )
                // alice's funding payment = -(bob's funding payment)
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )

                let [owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(alice.address)
                let liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

                // remove half of the liquidity of the order (50000, 50400); all pending funding payment should be settled
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity.div(2),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        "-272977241071563599",
                        "-8536030653991754908",
                        "-203202869155103601574",
                        parseEther("0.829279386920164902"),
                    )
                    .to.emit(clearingHouse, "FundingPaymentSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                let collectedFee = parseEther("0.829279386920164902")
                let fundingPayment = parseEther("-0.078257551883207429")
                let [owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(collectedFee.sub(fundingPayment))
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)

                await forward(3600)

                // 1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.07823581971
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )
                ;[owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(alice.address)
                liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

                // remove all the remaining liquidity of the order (50000, 50400)
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        "-272977241071563599",
                        "-8536030653991754908",
                        "-203202869155103601574",
                        "0",
                    )
                    .to.emit(clearingHouse, "FundingPaymentSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                ;[owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.078257551883207429"))
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)

                await forward(3600)

                // 1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.07823581971
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )
                ;[owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(alice.address)
                liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).liquidity

                // remove all liquidity of the order (50200, 50400)
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50200,
                        upperTick: 50400,
                        liquidity: liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        "-654045517856872800",
                        "0",
                        "-808767873126541797029",
                        parseEther("1"),
                    )
                    .to.emit(clearingHouse, "FundingPaymentSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                collectedFee = parseEther("1")
                fundingPayment = parseEther("0.078257551883207429")
                ;[owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(collectedFee.add(fundingPayment))
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)
            })

            describe("two makers with one order each", () => {
                it("one taker swaps, one maker reduces liquidity and then the taker swaps again in different direction", async () => {
                    //           |-----| alice range
                    //      |----------| carol range
                    //   -----------------------------> p
                    //                 50400             (154.4310960807)
                    //           50200                   (151.3733068587)
                    //     50000                         (148.3760629231)
                    //         <-------x
                    //         ---->
                    //           end  current

                    // carol opens an order with larger range
                    await clearingHouse.connect(carol).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("0"),
                        quote: parseEther("100"),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    })

                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -1.2
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1.2"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    await forward(3600)

                    // bob's funding payment = -1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = 0.07823581971
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.078235819711065467"),
                    )
                    // alice's funding payment = -(bob's funding payment) * liquidity share = -(0.07823581971 * 0.6540455179 / 1.2) = -0.04264148935
                    //                         = 0.6540455179 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.04264148935
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.042641489348233958"),
                    )
                    // carol's funding payment = -(bob's funding payment) * liquidity share = -(0.07823581971 * (1.2 - 0.6540455179) / 1.2) = -0.03559433036
                    //                         = 0.5459544821 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.03559433036
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.035594330362831508"),
                    )

                    let [owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(alice.address)
                    let liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                        .liquidity

                    // carol removes half of her liquidity; all pending funding payment should be settled
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // 0.5459544821 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.03560421767
                    await expect(
                        clearingHouse.connect(carol).removeLiquidity({
                            baseToken: baseToken.address,
                            lowerTick: 50000,
                            upperTick: 50400,
                            liquidity: liquidity.div(2),
                            minBase: 0,
                            minQuote: 0,
                            deadline: ethers.constants.MaxUint256,
                        }),
                    )
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            carol.address,
                            baseToken.address,
                            quoteToken.address,
                            50000,
                            50400,
                            "0",
                            "0",
                            "0",
                            parseEther("0.829279386920164902"),
                        )
                        .to.emit(clearingHouse, "FundingPaymentSettled")
                        .withArgs(carol.address, baseToken.address, parseEther("-0.035604217676821184"))

                    // verify owedRealizedPnl
                    let collectedFee = parseEther("0.829279386920164902")
                    let fundingPayment = parseEther("-0.035604217676821184")
                    let [owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(carol.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(collectedFee.sub(fundingPayment))
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)

                    // alice's funding payment shouldn't be affected by carol's liquidity removal
                    // however, the timestamp is 1 second ahead thx to hardhat: 0.6540455179 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.04265333421
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.042653334206386245"),
                    )

                    // bob's position -1.2 -> -0.8
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: ethers.constants.MaxUint256,
                        amount: parseEther("0.4"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    // note that bob will settle his pending funding payment here
                    await forward(3600)

                    // bob's funding payment = -0.8 * (151.9343974175 - 150.953124) * 3600 / 86400 = -0.03270911392
                    expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.032709113916506038"),
                    )
                    // note that the swap timestamp is 2 second ahead due to hardhat's default block timestamp increment
                    // alice's previous funding payment = 0.6540455179 * (149.3884076058 - 150.953124) * 3602 / 86400 = -0.04266517907
                    // alice's funding payment = previous funding payment + -(bob's funding payment) * liquidity share
                    //                         = -0.04266517907 +  -(-0.03270911392 * 0.532445975136213017 / 0.8) = -0.020895384
                    //                         = -0.04266517907 + 0.532445975136213017 * (151.9343974175 - 150.953124) * 3600 / 86400 = -0.020895384
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.020895383995644115"),
                    )
                    // carol's funding payment = -(bob's funding payment) * liquidity share = -(-0.03270911392 * 0.267554024863786981 / 0.8) = 0.01093931885
                    //                         = 0.267554024863786981 * (151.9343974175 - 150.953124) * 3600 / 86400 = 0.01093931885
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("0.010929431533621946"),
                    )
                })

                it("one maker swaps twice (becoming also taker); the first time does not use his/her own liquidity but the second one does", async () => {
                    //           |-----| alice range
                    //     |-----|       carol range
                    //   -----------------------------> p
                    //               50400               (154.4310960807)
                    //         50200                     (151.3733068587)
                    //   50000                           (148.3760629231)
                    //             <---x
                    //        <----
                    //       end    current

                    // carol opens an order, lower than alice's range
                    await clearingHouse.connect(carol).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("0"),
                        quote: parseEther("100"),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    })

                    // carol's position 0 -> -0.2
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.2"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    // price: 153.4862960887
                    await forward(3600)

                    // carol's funding payment = -0.2 * (153.4766329005 - 150.953124) * 3600 / 86400 = -0.02102924084
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.021029240837525072"),
                    )
                    // alice's funding payment = -(carol's funding payment) = -(-0.02102924084) = 0.02102924084
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.021029240837525072"),
                    )

                    // carol's position -0.2 -> -1.2
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    // price: 148.9142832775
                    await forward(3600)

                    // carol's funding payment = -0.654045517856872802 * (148.9111525791 - 150.953124) * 3600 / 86400 = 0.05564759398
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("0.055647593977026512"),
                    )
                    // Verification:
                    // carol's funding payment = -(alice's funding payment)
                    // alice's funding payment:
                    // alice liquidity: 808.767873126541797029
                    // alice's position size/base amount when price goes below the range:
                    // 808.767873126541797029 * (1 / sqrt(151.3733068587) - 1 / sqrt(154.4310960807)) = 0.6540455179 ~= -(carol's position size) = -0.654045517856872802

                    // alice's previous funding payment = -(-0.2 * (153.4766329005 - 150.953124) * 3601 / 86400) = 0.02103508229
                    // hence, alice's funding payment in total = previous funding payment + -(carol's funding payment) = 0.02103508229 - 0.05564759398 = -0.03461251169
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.034612511683713238"),
                    )

                    const [owedRealizedPnlBefore] = await accountBalance.getPnlAndPendingFee(carol.address)
                    let liquidity = (await orderBook.getOpenOrder(carol.address, baseToken.address, 50000, 50200))
                        .liquidity

                    // takerBaseBalance: -1.2
                    // takerQuoteBalance: 180.149240114722163229

                    // carol removes all her liquidity; all pending funding payment should be settled
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.654045517856872802 * (148.9111525791 - 150.953124) * 3601 / 86400 = 0.05566305164

                    const tx = await clearingHouse.connect(carol).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity: liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })

                    await expect(tx)
                        .to.emit(clearingHouse, "FundingPaymentSettled")
                        .withArgs(carol.address, baseToken.address, parseEther("0.055663051642020131"))
                    await expect(tx)
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            carol.address,
                            baseToken.address,
                            quoteToken.address,
                            50000,
                            50200,
                            "-545954482143127198",
                            "-18031070591189734109",
                            "-816895716963038010374",
                            parseEther("0.819689294088102658"),
                        )
                    await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                        carol.address,
                        baseToken.address,
                        "545954482143127198", // exchangedPositionSize
                        "-81968929408810265891", // exchangedPositionNotional
                        "0", // fee
                        "98188169201962983990", // openNotional
                        "-7858496051086652", // realizedPnl
                        Object, // sqrtPriceAfterX96
                    )

                    // closedRatio = 0.545954482143127198 / 1.2 = 0.454962068452605998
                    // reducedOpenNotional = 0.4549620685 * 180.149240114722163229 = 81.961070912759179239
                    // deltaQuote = 18.031070591189734109(quote removed from pool) - 100 (originally added) = -81.968929408810265891
                    // realized pnl: 81.961070912759179239 + -81.968929408810265891 = -0.007858496051

                    let collectedFee = parseEther("0.819689294088102658")
                    let fundingPayment = parseEther("0.055663051642020131")
                    // verify owedRealizedPnl
                    const [owedRealizedPnlAfter] = await accountBalance.getPnlAndPendingFee(carol.address)
                    // -0.055663051642020131(fundingPayment) + 0.819689294088102658(fee) + (-0.007858496051(realizedPnl)) = 0.756167746394995875
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.756167746394995875"))
                    expect(await exchange.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)

                    // alice's funding payment shouldn't be affected by carol's liquidity removal
                    // 0.02103508229 - 0.055663051642020131 = -0.03462796935
                    expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.034627969348706857"),
                    )

                    // TODO: missing the second time addLiquidity()?
                })
            })
        })

        describe("max funding rate exceeded", async () => {
            beforeEach(async () => {
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })

                // set max funding rate to 10%
                await clearingHouseConfig.setMaxFundingRate(0.1e6)

                // alice provides liquidity with the range inside
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("10"),
                    quote: parseEther("10000"),
                    lowerTick: 20000,
                    upperTick: 80000,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                await collateral.mint(bob.address, parseUnits("1000000", collateralDecimals))
                await deposit(bob, vault, 1000000, collateral)
            })

            it("markTwap above indexTwap and exceeded max funding rate", async () => {
                // initial mark price 154.4310961, bob takes long
                await q2bExactOutput(fixture, bob, 0.1)
                // current mark price 156.844502866592198095

                // index price 50
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("50", 6), 0, 0, 0]
                })

                await forward(100)

                // diff: 156.844502 - 50 > 50 * 10%
                // bob's funding payment = 0.1 * 50 * 10% * 100 / 86400 = 0.0005787037037
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.be.eq(
                    parseEther("0.000578703703703703"),
                )

                // alice's funding payment
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.be.eq(
                    parseEther("-0.000578703703703703"),
                )
            })

            it("markTwap below indexTwap and exceeded max funding rate", async () => {
                // initial mark price 154.4310961, bob takes short
                await b2qExactInput(fixture, bob, 0.1)
                // current mark price 152.072967341735143415

                // index price 200
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("200", 6), 0, 0, 0]
                })

                await forward(100)

                // diff: 200 - 152.072967341735143415 > 200 * 10%
                // bob's funding payment = 0.1 * 200 * 10% * 100 / 86400 = 0.002314814815
                expect(await exchange.getPendingFundingPayment(bob.address, baseToken.address)).to.be.eq(
                    parseEther("0.002314814814814814"),
                )

                // alice's funding payment
                expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.be.eq(
                    parseEther("-0.002314814814814814"),
                )
            })
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("markTwapX96")
// console.log((await clearingHouse.getMarkTwapX96(baseToken.address, twapInterval)).toString())
// console.log("pendingFundingPayment")
// console.log("bob")
// console.log((await exchange.getPendingFundingPayment(bob.address, baseToken.address)).toString())
// console.log("carol")
// console.log(
//     "pendingFundingPayment: ",
//     (await exchange.getPendingFundingPayment(carol.address, baseToken.address)).toString(),
// )
// console.log("positionSize: ", (await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).toString())
// console.log("alice")
// console.log(
//     "pendingFundingPayment: ",
//     (await exchange.getPendingFundingPayment(alice.address, baseToken.address)).toString(),
// )
// console.log("positionSize: ", (await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).toString())
// // === useful console.log for verifying stats ===
