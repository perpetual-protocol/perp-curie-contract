import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe.skip("ClearingHouse.openPosition gasEstimation", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
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
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(false))
        clearingHouse = _clearingHouseFixture.clearingHouse as ClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        await initAndAddPool(
            _clearingHouseFixture,
            pool,
            baseToken.address,
            encodePriceSqrt("100", "1"),
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(tickSpacing),
        )

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("1000000", collateralDecimals))
        await deposit(alice, vault, 1000000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000000", collateralDecimals))
        await deposit(carol, vault, 1000000, collateral)
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
    })

    it("gas cost for maker", async () => {
        // carol long
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        for (let i = 0; i < 720; i++) {
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            await forward(3600)
        }

        // maker remove liquidity position
        const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false,
            oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }).timeout(300000) // 5 mins
})
