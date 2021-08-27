import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

// TODO make every test fail bcs of oppositeAmountBound
describe("ClearingHouse openPosition slippage in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await exchange.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 1000, collateral)
    })

    // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=238402888
    describe("taker open position from zero", () => {
        afterEach(async () => {
            expect(await clearingHouse.getOwedRealizedPnl(taker.address)).eq(parseEther("0"))
        })

        it.only("Q2B exactInput", async () => {
            // taker swap exact 250 USD for 19.84 ETH
            expect(
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: parseEther("250"),
                    oppositeAmountBound: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                }),
            ).to.be.revertedWith("CH_TLR")
        })

        // it("increase positionSize and openNotional (negative for long) - exactOutput", async () => {
        //     // taker swap 252.53 USD for exact 20 ETH
        //     await clearingHouse.connect(taker).openPosition({
        //         baseToken: baseToken.address,
        //         isBaseToQuote: false,
        //         isExactInput: false,
        //         amount: parseEther("20"),
        //         sqrtPriceLimitX96: 0,
        //     })
        //     expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("20"))
        //     expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).closeTo(
        //         parseEther("-252.525252525252525252"),
        //         1,
        //     )
        // })
        //
        // it("increase -positionSize and openNotional (positive for short) - exactInput", async () => {
        //     // taker swap exact 25 ETH for 198 USD
        //     await clearingHouse.connect(taker).openPosition({
        //         baseToken: baseToken.address,
        //         isBaseToQuote: true,
        //         isExactInput: true,
        //         amount: parseEther("25"),
        //         sqrtPriceLimitX96: 0,
        //     })
        //     expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
        //     expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        // })
        //
        // it("increase -positionSize and openNotional (positive for short) - exactOutput", async () => {
        //     // taker swap exact 25 ETH for 198 USD
        //     await clearingHouse.connect(taker).openPosition({
        //         baseToken: baseToken.address,
        //         isBaseToQuote: true,
        //         isExactInput: false,
        //         amount: parseEther("198"),
        //         sqrtPriceLimitX96: 0,
        //     })
        //     expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
        //     expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        // })
    })
})
