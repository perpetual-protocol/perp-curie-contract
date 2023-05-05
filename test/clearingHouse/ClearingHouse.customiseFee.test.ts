import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    Vault,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { encodePriceSqrt, mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse customized fee", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, "151")

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // maker
        //   pool.base = 65.9437860798
        //   pool.quote = 10000
        //   liquidity = 884.6906588359
        //   virtual base liquidity = 884.6906588359 / sqrt(151.373306858723226652) = 71.9062751863
        //   virtual quote liquidity = 884.6906588359 * sqrt(151.373306858723226652) = 10884.6906588362

        // prepare collateral for taker
        const takerCollateral = parseUnits("2000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await collateral.mint(taker2.address, takerCollateral)
        await collateral.connect(taker2).approve(clearingHouse.address, takerCollateral)
    })

    describe("CH fee ratio(2%) > uniswap pool fee ratio(1%)", async () => {
        beforeEach(async () => {
            // set fee ratio to 2%
            await marketRegistry.setFeeRatio(baseToken.address, 20000)
        })

        describe("taker open position from zero", async () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)
            })

            it("long and exact in", async () => {
                // taker swap 1 USD for ? ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        "6473478014450606", // exchangedPositionSize
                        parseEther("-0.98"), // exchangedPositionNotional
                        parseEther("0.02"), // fee = 1 * 0.02
                        parseEther("-1"), // openNotional
                        parseEther("0"), // realizedPnl
                        "974862428376799548021608444199", // sqrtPriceAfterX96
                    )

                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                    "6473478014450606",
                )

                const fee = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(fee).to.be.closeTo(parseEther("0.02"), 1)
            })

            it("long and exact out", async () => {
                // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
                // exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
                // (qr * (1 - x)) * y / (1 - y)
                //   taker fee = 153.508143394 / 0.98 * 0.02 = 3.13281925
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: ethers.constants.MaxUint256,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("1"), // exchangedPositionSize
                        "-153508143394151325059", // exchangedPositionNotional
                        "3132819252941863777", // fee
                        "-156640962647093188836", // openNotional
                        parseEther("0"), // realizedPnl
                        "988522032908775036581348357236", // sqrtPriceAfterX96
                    )
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                    parseEther("1"),
                )

                const fee = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(fee).to.be.closeTo(parseEther("3.132819252941863777"), 1)
            })

            it("short and exact in", async () => {
                // taker swap ? USD for 1 ETH -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.02 = 2.98594068371

                // taker swap 1 ETH for ? USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-1"), // exchangedPositionSize
                        parseEther("149.297034185732877727"), // exchangedPositionNotional
                        parseEther("2.985940683714657555"), // fee: 149.297034185732877727 * 0.02 = 2.985940683714657555
                        parseEther("146.311093502018220172"), // openNotional
                        parseEther("0"), // realizedPnl
                        "961404421142614700863221952241", // sqrtPriceAfterX96
                    )
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                    parseEther("-1"),
                )

                const fee = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(fee).to.be.closeTo(parseEther("2.985940683714657555"), 2)
            })

            it("short and exact out", async () => {
                // taker swap ? ETH for 1 USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: ethers.constants.MaxUint256,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-0.006741636644634247"), // exchangedPositionSize
                        parseEther("1.020408163265306123"), // exchangedPositionNotional = 1 / 0.98
                        parseEther("0.020408163265306123"), // fee: 1 / 0.98 * 0.02
                        parseEther("1"), // openNotional
                        parseEther("0"), // realizedPnl
                        "974683282523420024722339861717", // sqrtPriceAfterX96
                    )
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                    parseEther("-0.006741636644634247"),
                )

                const fee = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(fee).to.be.closeTo(parseEther("0.020408163265306123"), 1)
            })
        })

        describe("opening long first then", () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)
                await deposit(taker2, vault, 1000, collateral)

                // 71.9062751863 - 884.6906588359 ^ 2  / (10884.6906588362 + 2 * 0.99) = 0.01307786649
                // taker swap 2 USD for 0.01307786649 ETH
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // virtual base liquidity = 71.9062751863 - 0.01307786649 = 71.8931973198
                // virtual quote liquidity = 10884.6906588362 + 2 * 0.99 = 10886.6706588362
            })

            it("increase position and exact in", async () => {
                // taker swap 1 USD for ? ETH again

                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const fee = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(fee).to.be.closeTo(parseEther("0.06"), 1)

                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                    "19416937961245645",
                )
            })

            it("increase position and exact out", async () => {
                // taker2 moves the price back to tick 50200 for easy calculation
                await clearingHouse.connect(taker2).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const feeBeforeSwap = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee

                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const feeAfterSwap = (
                    await clearingHouse.connect(maker).callStatic.removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: 0,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })
                ).fee
                expect(feeAfterSwap.sub(feeBeforeSwap)).to.be.closeTo(parseEther("3.132819252941863777"), 1)
            })
        })
    })

    describe("CH fee ratio < uniswap pool fee ratio", async () => {
        beforeEach(async () => {
            // set fee ratio to 0.5%
            await marketRegistry.setFeeRatio(baseToken.address, 5000)
            await deposit(taker, vault, 1000, collateral)
        })

        it("long and exact in", async () => {
            // taker swap 1 USD for ? ETH
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    "6572552804907016", // exchangedPositionSize
                    parseEther("-0.995"), // exchangedPositionNotional
                    parseEther("0.005"), // fee = 1 * 0.005
                    parseEther("-1"), // openNotional
                    parseEther("0"), // realizedPnl
                    "974863771696553005985543622107", // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "6572552804907016",
            )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.005"), 1)
        })

        it("long and exact out", async () => {
            // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
            // exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
            // (qr * (1 - x)) * y / (1 - y)
            //   taker fee = 153.508143394 / 0.995 * 0.005 = 0.77139771

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    parseEther("1"), // exchangedPositionSize
                    "-153508143394151325059", // exchangedPositionNotional
                    parseEther("0.771397705498247865"), // fee
                    "-154279541099649572924", // openNotional
                    parseEther("0"), // realizedPnl
                    "988522032908775036581348357236", // sqrtPriceAfterX96
                )
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(parseEther("1"))

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.771397705498247865"), 1)
        })

        it("short and exact in", async () => {
            // taker swap ? USD for 1 ETH -> base to quote -> fee is included in exchangedNotional
            //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
            //   taker fee = 149.2970341856 * 0.005 = 0.74648517

            // taker swap 1 ETH for ? USD
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    parseEther("-1"), // exchangedPositionSize
                    parseEther("149.297034185732877727"), // exchangedPositionNotional
                    parseEther("0.746485170928664389"), // fee
                    parseEther("148.550549014804213338"), // openNotional
                    parseEther("0"), // realizedPnl
                    "961404421142614700863221952241", // sqrtPriceAfterX96
                )
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(parseEther("-1"))

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.746485170928664389"), 2)
        })

        it("short and exact out", async () => {
            // taker swap 1 ETH for ? USD
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    parseEther("-0.006639994546394814"), // exchangedPositionSize
                    parseEther("1.005025125628140704"), // exchangedPositionNotional = 1 / 0.995
                    parseEther("0.005025125628140704"), // fee: 1 / 0.995 * 0.005 = 0.00502513
                    parseEther("1"), // openNotional
                    parseEther("0"), // realizedPnl
                    "974684660145975104164388030226", // sqrtPriceAfterX96
                )
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                parseEther("-0.006639994546394814"),
            )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.005025125628140704"), 2)
        })
    })

    describe("change CH fee ratio", async () => {
        beforeEach(async () => {
            // set fee ratio to 0.5%
            await marketRegistry.setFeeRatio(baseToken.address, 20000)
            await deposit(taker, vault, 1000, collateral)

            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("change from 2% to 3%", async () => {
            await marketRegistry.setFeeRatio(baseToken.address, 30000)

            // taker swap 1 USD for ? ETH
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    "6406274427766891", // exchangedPositionSize
                    parseEther("-0.97"), // exchangedPositionNotional
                    parseEther("0.03"), // fee = 1 * 0.03
                    parseEther("-2"), // openNotional
                    parseEther("0"), // realizedPnl
                    "974949296387523163022749948882", // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "12879752442217497",
            )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.05"), 1)
        })

        it("change from 2% to 1%", async () => {
            await marketRegistry.setFeeRatio(baseToken.address, 10000)

            // taker swap 1 USD for ? ETH
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    "6538350548602818", // exchangedPositionSize
                    parseEther("-0.99"), // exchangedPositionNotional
                    parseEther("0.01"), // fee = 1 * 0.01
                    parseEther("-2"), // openNotional
                    parseEther("0"), // realizedPnl
                    "974951087480527773641330186092", // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "13011828563053424",
            )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.03"), 1)
        })

        it("change from 2% to 3% and then to 5%", async () => {
            await marketRegistry.setFeeRatio(baseToken.address, 30000)

            // taker swap 1 USD for ? ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await marketRegistry.setFeeRatio(baseToken.address, 50000)

            // taker swap 1 USD for ? ETH
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    "6273079857818529", // exchangedPositionSize
                    parseEther("-0.95"), // exchangedPositionNotional
                    parseEther("0.05"), // fee = 1 * 0.05
                    parseEther("-3"), // openNotional
                    parseEther("0"), // realizedPnl
                    "975034373305242167405311216355", // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "19152832300036026",
            )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.1"), 1)
        })
    })

    describe("change taker's fee discount ratio", async () => {
        beforeEach(async () => {
            // set fee ratio to 2%
            await marketRegistry.setFeeRatio(baseToken.address, 20000)
            await deposit(taker, vault, 1000, collateral)

            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("swap with customized discount", async () => {
            await marketRegistry.setFeeDiscountRatio(taker.address, 0.1e6)

            // taker swap 1 USD for ? ETH
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address, // trader
                    baseToken.address, // baseToken
                    "6485520158501717", // exchangedPositionSize
                    parseEther("-0.982"), // exchangedPositionNotional = -(1-0.018)
                    parseEther("0.018"), // fee = 1 * 0.02 * 0.9
                    parseEther("-2"), // openNotional = -1 + -1
                    parseEther("0"), // realizedPnl
                    "974950371043325929393898091208", // sqrtPriceAfterX96
                )

            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.closeTo(parseEther("0.038"), 1) // 0.018 + 0.02
        })
    })

    describe("CH fee with multiple makers", async () => {
        let liquidity1: BigNumber
        let liquidity2: BigNumber
        let liquidity3: BigNumber
        let totalLiquidity: BigNumber
        beforeEach(async () => {
            // current tick of pool is at 50201
            // maker's 2nd liquidity in range [50000, 50400]
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("2"),
                quote: parseEther("201"),
                lowerTick: 50000,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // maker's 3rd liquidity in range [49800, 50600]
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("2"),
                quote: parseEther("201"),
                lowerTick: 49800,
                upperTick: 50600,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await deposit(taker, vault, 2000, collateral)

            liquidity1 = (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick))
                .liquidity
            liquidity2 = (await orderBook.getOpenOrder(maker.address, baseToken.address, 50000, 50400)).liquidity
            liquidity3 = (await orderBook.getOpenOrder(maker.address, baseToken.address, 49800, 50600)).liquidity
            totalLiquidity = liquidity1.add(liquidity2).add(liquidity3)
        })

        it("long and exact in, 3 makers get their fees", async () => {
            const totalFee = parseEther("1") // fee = 100 * 0.01
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("100"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address,
                    baseToken.address,
                    "652445932493383066", // exchangedPositionSize
                    parseEther("-99"), // exchangedPositionNotional
                    totalFee, // fee
                    parseEther("-100"), // openNotional
                    parseEther("0"), // realizedPnl
                    "977114821773012427278909819665",
                )

            // all orders get their fee by liquidity ratio
            const fee1 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee1).to.be.closeTo(totalFee.mul(liquidity1).div(totalLiquidity), 1)

            const fee2 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee2).to.be.closeTo(totalFee.mul(liquidity2).div(totalLiquidity), 1)

            const fee3 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 49800,
                    upperTick: 50600,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee3).to.be.closeTo(totalFee.mul(liquidity3).div(totalLiquidity), 1)

            // The three maker fees should be no more than the total fee
            expect(fee1.add(fee2).add(fee3)).lte(totalFee)
        })

        it("short and exact out, 3 makers get their fees", async () => {
            const totalFee = parseEther("1.010101010101010102") // 100 / 0.99 * 0.01
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("100"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address,
                    baseToken.address,
                    "-668929885027494518", // exchangedPositionSize
                    parseEther("101.010101010101010102"), // exchangedPositionNotional
                    totalFee, // fee
                    parseEther("100"), // openNotional
                    parseEther("0"), // realizedPnl
                    "972386993200923694471960483504",
                )

            // all orders get their fee by liquidity ratio
            const fee1 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee1).to.be.closeTo(totalFee.mul(liquidity1).div(totalLiquidity), 1)

            const fee2 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee2).to.be.closeTo(totalFee.mul(liquidity2).div(totalLiquidity), 1)

            const fee3 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 49800,
                    upperTick: 50600,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee3).to.be.closeTo(totalFee.mul(liquidity3).div(totalLiquidity), 1)

            // The three maker fees should be no more than the total fee
            expect(fee1.add(fee2).add(fee3)).lte(totalFee)
        })

        it("long and exact in, 3 makers get their fees", async () => {
            const totalFee = parseEther("1") // fee = 100 * 0.01
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("100"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address,
                    baseToken.address,
                    "652445932493383066", // exchangedPositionSize
                    parseEther("-99"), // exchangedPositionNotional
                    totalFee, // fee
                    parseEther("-100"), // openNotional
                    parseEther("0"), // realizedPnl
                    "977114821773012427278909819665",
                )

            // all orders get their fee by liquidity ratio
            const fee1 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee1).to.be.closeTo(totalFee.mul(liquidity1).div(totalLiquidity), 1)

            const fee2 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee2).to.be.closeTo(totalFee.mul(liquidity2).div(totalLiquidity), 1)

            const fee3 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 49800,
                    upperTick: 50600,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee3).to.be.closeTo(totalFee.mul(liquidity3).div(totalLiquidity), 1)

            // The three maker fees should be no more than the total fee
            expect(fee1.add(fee2).add(fee3)).lte(totalFee)
        })

        it("long and exact in, cross 2 ranges, 3 makers get their fees", async () => {
            const totalFee = parseEther("20").add(2) // fee = 1000 * 0.01 + 2wei (rounding up)

            // mock index price higher, let taker open a large long position
            await mockIndexPrice(mockedPriceFeedDispatcher, "198.687932")

            // taker open a large position, crossed 2 ranges
            // making the price becomes ~= 198.2516818352, tick ~= 52898.018163
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("2000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address,
                    baseToken.address,
                    "11729654997396309954", // exchangedPositionSize
                    parseEther("-1979.999999999999999998"), // exchangedPositionNotional
                    totalFee, // fee
                    "-2000000000000000000000", // openNotional
                    parseEther("0"), // realizedPnl
                    "1115547388545533386227414561311",
                )

            // range2 and range3 get fees less than totalFee * liquidity ratio (out of range)
            // liquidity2     ~= 1,641.9603910957
            // liquidity3     ~=   825.0848570922
            // totalLiquidity ~= 3,351.7359070238
            // however, the price leaves range2 earlier than range3, thus
            // fee2 ~= 2.0507068897
            // fee3 ~= 2.0713158009
            const fee2 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee2).to.be.lt(totalFee.mul(liquidity2).div(totalLiquidity))

            const fee3 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 49800,
                    upperTick: 50600,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee3).to.be.lt(totalFee.mul(liquidity3).div(totalLiquidity))

            // range1 gets the rest of the fees (still in range)
            const fee1 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee

            // The three maker fees should be no more than the total fee
            expect(fee1.add(fee2).add(fee3)).lte(totalFee)
        })

        it("short and exact out, cross 2 ranges, 3 makers get their fees", async () => {
            const totalFee = parseEther("20.202020202020202022") // fee = 2000 / 0.99 * 0.01

            // mock index price lower, let taker open a large short position
            await mockIndexPrice(mockedPriceFeedDispatcher, "109.710327")

            // taker open a large position, crossed 2 ranges
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("2000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    taker.address,
                    baseToken.address,
                    "-15252808300295787035", // exchangedPositionSize
                    "2020202020202020202021", // exchangedPositionNotional
                    totalFee, // fee
                    "1999999999999999999999", // openNotional
                    parseEther("0"), // realizedPnl
                    "829857148898043164180052942590",
                )

            // range2 and range3 get fess less than totalFee * liquidity ratio (out of range)
            const fee2 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee2).to.be.lt(totalFee.mul(liquidity2).div(totalLiquidity))

            const fee3 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 49800,
                    upperTick: 50600,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee3).to.be.lt(totalFee.mul(liquidity3).div(totalLiquidity))

            // range1 get all the rest fees (still in range)
            const fee1 = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee

            // The three maker fees should be no more than the total fee
            expect(fee1.add(fee2).add(fee3)).lte(totalFee)
        })
    })
})
