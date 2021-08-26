import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Exchange, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate maker", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: VirtualToken
    let baseToken: VirtualToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let baseToken2: VirtualToken
    let mockedBaseAggregator2: MockContract
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), 6), 0, 0, 0]
        })
    }

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        exchange = _clearingHouseFixture.exchange
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
        await exchange.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("200", collateralDecimals))
        await deposit(alice, vault, 200, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("100"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("900"))
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("90"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    it("force fail, maker still has liquidity", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
        await deposit(bob, vault, 10000000, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true, // exact input (quote)
            amount: parseEther("1000"),
            sqrtPriceLimitX96: 0,
        })

        setPool1IndexPrice(100000)

        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
            "CH_NEO",
        )
    })

    // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1758593105
    it("bob long, maker (alice) should be liquidated", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
        await deposit(bob, vault, 10000000, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true, // exact input (quote)
            amount: parseEther("1000"),
            sqrtPriceLimitX96: 0,
        })

        setPool1IndexPrice(100000)

        await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)

        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.emit(
            clearingHouse,
            "PositionLiquidated",
        )
    })
})
