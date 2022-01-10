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
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("AccountBalance", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let collateralDecimals: number
    let tickSpacing: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice
        await collateral.mint(alice.address, parseUnits("40000", collateralDecimals))
        await deposit(alice, vault, 40000, collateral)

        // bob
        await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)
    })

    describe("getBaseTokens()", () => {
        beforeEach(async () => {
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(await pool.tickSpacing()),
            )

            await initAndAddPool(
                fixture,
                pool2,
                baseToken2.address,
                encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(await pool2.tickSpacing()),
            )
        })

        it("alice add liquidity", async () => {
            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([])

            // alice add liquidity (baseToken)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("1000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([baseToken.address])

            // alice add liquidity (baseToken2)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("100"),
                quote: parseEther("1000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([
                baseToken.address,
                baseToken2.address,
            ])
        })

        it("alice remove liquidity", async () => {
            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([])

            // alice add liquidity (baseToken)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("1000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([baseToken.address])

            // alice remove liquidity (baseToken)
            const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))
                .liquidity
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getBaseTokens(alice.address)).be.deep.eq([])
        })

        it("bob open position", async () => {
            expect(await accountBalance.getBaseTokens(bob.address)).be.deep.eq([])

            // alice add liquidity (baseToken)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("1000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // alice add liquidity (baseToken2)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("100"),
                quote: parseEther("1000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob short 1 base (baseToken2)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getBaseTokens(bob.address)).be.deep.eq([baseToken2.address])

            // bob long 100 quote (baseToken)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getBaseTokens(bob.address)).be.deep.eq([baseToken2.address, baseToken.address])
        })
    })

    describe("# setVault", async () => {
        it("set vault and emit event", async () => {
            await expect(accountBalance.setVault(vault.address))
                .to.emit(accountBalance, "VaultChanged")
                .withArgs(vault.address)
        })

        it("force error, cannot set to a EOA address", async () => {
            await expect(accountBalance.setVault(alice.address)).to.be.revertedWith("AB_VNC")
        })
    })
})
