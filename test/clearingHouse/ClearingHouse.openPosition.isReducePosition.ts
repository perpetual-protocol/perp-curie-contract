import { MockContract } from "@eth-optimism/smock"
import { LogDescription } from "@ethersproject/abi"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { forwardTimestamp } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse isIncreasePosition when trader is both of maker and taker", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let mockedBaseAggregator2: MockContract
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        quoteToken = _clearingHouseFixture.quoteToken
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await marketRegistry.addPool(baseToken.address, "10000")

        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)

        await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)

        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
    })

    function findPositionChangedEvents(receipt: TransactionReceipt): LogDescription[] {
        const topic = exchange.interface.getEventTopic("PositionChanged")
        return receipt.logs.filter(log => log.topics[0] === topic).map(log => exchange.interface.parseLog(log))
    }

    describe("trader is both of maker and taker", async () => {
        it("alice provides liquidity above price then open long position", async () => {
            // 1. alice provides liquidity above price => get short position when anyone swaps
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("0"),
                lowerTick: 24000, // 11.021853767
                upperTick: 24200, // 11.2444987389
                minBase: 0,
                minQuote: 0,
                useTakerPositionSize: false,
                deadline: ethers.constants.MaxUint256,
            })
            // alice's base: -100
            // alice's quote: 0
            // alice's base in pool: 100
            // alice's quote in pool: 0
            // positionSize: -100+100 = 0
            // openNotional: 0 + 0 = 0

            // 2. alice long 1 ETH with 11.134293448835387788 USDC
            // the position size is not changed because alice take her own order.
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // maker fee to alice: 0.111342934488353878
            // alice's total maker fee = 0.111342934488353878
            // alice's base balance: -100 + 1 = -99
            // alice's quote balance: -11.134293448835387788
            // alice's base in pool: 99
            // alice's quote in pool: 11.02295051434703391
            // alice's positionSize: -99 + (99) = 0
            // alice's openNotional: quoteBalance + quoteInPool + makerFee
            //                     = -11.134293448835387788 + 11.02295051434703391 + 0.111342934488353878 = 0

            // 3. bob long larger ETH with 1113.3727442283 USDC
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("98.999999999999999999"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // maker fee to alice: 11.133727442282721574
            // exchangedQuote: 1102.239016785989435789
            // alice's total maker fee = 0.111342934488353878 + 11.133727442282721574 = 11.2450703768
            // alice's base balance: -99
            // alice's quote balance: -11.134293448835387788
            // alice's base in pool: ~= 0
            // alice's quote in pool: 11.02295051434703391 + 1102.239016785989435789 = 1113.2619673003
            // alice's positionSize: -99 + (0) = -99
            // alice's openNotional: quoteBalance + quoteInPool + makerFee
            //                     = -11.134293448835387788 + 1113.2619673003 + 11.2450703768 = 1113.3727442283

            // 4. Introduce another maker(carol) here to avoid alice is dealing with herself.
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("0"),
                lowerTick: 24400, // 11.4716412105
                upperTick: 24600, // 11.7033720327
                minBase: 0,
                minQuote: 0,
                useTakerPositionSize: false,
                deadline: ethers.constants.MaxUint256,
            })

            // 5. alice long 1 ETH
            // it should reduce position, and settle pnl after swap
            const receipt = await (
                await clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            ).wait()
            // maker fee to carol: 0.115886694087506447
            // alice's total maker fee = 11.2450703768
            // exchangedQuoteNotional: -11.472782714663138167
            // alice's quote balance: -11.134293448835387788 + (-11.472782714663138167) - 0.115886694087506447 = -22.7229628576
            // alice's base: -99 + 1 = -98
            // alice's base in pool: ~= 0
            // alice's quote in pool: 1113.2619673003
            // alice's position: -98 + 0 = -98
            // alice's openNotional before swap = 1113.3727442283
            // alice's openNotional after swap = 1113.3727442283 + (-11.472782714663138167) - 0.115886694087506447 = 1101.7840748195
            // alice's owedRealizedPnL after settled: (1113.3727442283 * 1 / 99) + (-11.472782714663138167-0.115886694087506447) = -0.34248007311
            // alice's quote balance after settled pnl: quote balance - settledPnL = -22.7229628576 - (-0.34248007311) = -22.3804827845
            // alice's openNotional after settled: quoteBalance(after settled) + quoteInPool + makerFee
            //                                  = -22.3804827845 + 1113.2619673003 + 11.2450703768 = 1102.1265548926

            // Assert event value
            const event = findPositionChangedEvents(receipt)[0].args
            expect(event.realizedPnl).to.eq(parseEther("-0.342480073111531925"))
            expect(event.openNotional).to.eq(parseEther("1102.126554892633044672"))

            // Assert api value
            const pnls = await accountBalance.getOwedAndUnrealizedPnl(alice.address)
            const owedRealizedPnl = pnls[0]
            expect(owedRealizedPnl).to.eq(parseEther("-0.342480073111531925"))
            expect(await exchange.getOpenNotional(alice.address, baseToken.address)).to.eq(
                parseEther("1102.126554892633044672"),
            )

            // set MaxTickCrossedWithinBlock to enable price checking before/after swap
            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)

            // 6. alice long ETH
            // it should reduce position, and the price should be over price limit `before` swap due to bob has swapped `large` ETH amount.
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLBS")

            // update block timestamp to update _lastUpdatedTickMap
            await forwardTimestamp(clearingHouse)

            // 7. alice long `large` ETH amount
            // it should reduce position, and the price should be over price limit `after` swap due to alice is trying to swap `large` ETH amount.
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("90"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLAS")
        })

        it("alice provides liquidity below price then open short position", async () => {
            // 1. alice provides liquidity blow price => get long position when anyone swaps
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("1000"),
                lowerTick: 22000, // 9.0240208687
                upperTick: 22200, // 9.206308977
                minBase: 0,
                minQuote: 0,
                useTakerPositionSize: false,
                deadline: ethers.constants.MaxUint256,
            })
            // alice's base: 0
            // alice's quote: -1000
            // alice's base in pool: 0
            // alice's quote in pool: 1000
            // positionSize: 0
            // openNotional:  -1000 + 1000 = 0

            // 2. alice short 1.097293757712888398 ETH with 10 USDC
            // the position size is not changed because alice take her own order.
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // maker fee to alice: 0.101010101010101011
            // alice's total maker fee =  0.101010101010101011
            // alice's base balance: -1.097293757712888398
            // alice's quote balance: -1000 + 10 = -990
            // alice's base in pool: 1.097293757712888398
            // alice's quote in pool: 1000 - 10.101010101010101011
            // alice's positionSize: -1.097293757712888398 + (1.097293757712888398) = 0
            // alice's openNotional: quoteBalance + quoteInPool + makerFee
            //                     = -990 + (1000 - 10.101010101010101011) + 0.101010101010101011 = 0

            // 3. bob short 108.615476541063518456 ETH with 979.999999999999999998 USDC
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("979.999999999999999998"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // maker fee to alice: 9.9.89898989898989899
            // exchangedBase: 108.615476541063518456
            // alice's total maker fee = 0.101010101010101011 + 9.89898989898989899 = 10
            // alice's base balance: -1.097293757712888398
            // alice's quote balance: -990
            // alice's base in pool: 1.097293757712888398 + 108.615476541063518456
            // alice's quote in pool: ~=0
            // alice's positionSize: -1.097293757712888398 + (1.097293757712888398 + 108.615476541063518456) = 108.615476541063518456
            // alice's openNotional: quoteBalance + quoteInPool + makerFee
            //                     =  -990 + 0 + 10 = -980

            // 4. Introduce another maker(carol) here to avoid alice is dealing with herself.
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("1000"),
                lowerTick: 21600,
                upperTick: 21800,
                minBase: 0,
                minQuote: 0,
                useTakerPositionSize: false,
                deadline: ethers.constants.MaxUint256,
            })

            // 5. alice short 1.142072881485844394 ETH with 10 USDC
            // it should reduce position, and should settle pnl after swap
            const receipt = await (
                await clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            ).wait()
            // maker fee to carol: 0.101010101010101011
            // alice's total maker fee = 10
            // exchangedQuoteNotional: 10.101010101010101011
            // alice's base balance: -1.097293757712888398 + (-1.142072881485844394)
            // alice's quote balance: -990 + 10 = -980
            // alice's base in pool: 1.097293757712888398 + 108.615476541063518456
            // alice's quote in pool: ~=0
            // alice's position: 108.615476541063518456 + (-1.142072881485844394) = 107.4734036596
            // alice's openNotional before swap = -980
            // alice's openNotional after swap = -980 + 10 = -970
            // alice's owedRealizedPnL after settled: (-980 * 1.142072881485844394 / 108.615476541063518456) + (10) = -0.30452988375
            // alice's quote balance after settled pnl: quote balance - settledPnL = -980 - (-0.30452988375) = -979.695470116
            // alice's openNotional after settled: quoteBalance(after settled) + quoteInPool + makerFee
            //                                  = -979.695470116 + 0 + 10 = -969.695470116

            // Assert event value
            const event = findPositionChangedEvents(receipt)[0].args
            expect(event.realizedPnl).to.eq(parseEther("-0.304529883759126820"))
            expect(event.openNotional).to.eq(parseEther("-969.695470116240873180"))

            // Assert api value
            const pnls = await accountBalance.getOwedAndUnrealizedPnl(alice.address)
            const owedRealizedPnl = pnls[0]
            expect(owedRealizedPnl).to.eq(parseEther("-0.304529883759126820"))
            expect(await exchange.getOpenNotional(alice.address, baseToken.address)).to.eq(
                parseEther("-969.695470116240873180"),
            )

            // set MaxTickCrossedWithinBlock to enable price checking before/after swap
            await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)

            // 6. alice short ETH
            // it should reduce position, and the price should be over price limit `before` swap because bob has swapped `large` ETH amount.
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLBS")

            // update block timestamp to update _lastUpdatedTickMap
            await forwardTimestamp(clearingHouse)

            // 7. alice short large ETH amount
            // it should reduce position, and the price should be over price limit `after` swap due to alice is trying to swap `large` ETH amount.
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("800"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLAS")
        })
    })
})
