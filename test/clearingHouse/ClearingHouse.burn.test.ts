import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.burn", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract

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

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })
    })

    describe("burn quote when debt = 10", () => {
        beforeEach(async () => {
            // prepare collateral for alice
            await collateral.mint(alice.address, parseUnits("10", await collateral.decimals()))
            await deposit(alice, vault, 10, collateral)
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("10", await collateral.decimals()))
        })

        it("maker earns vQuote fee after all takers close position", async () => {
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await exchange.addPool(baseToken.address, 10000)

            const lowerTick = 50000 // 148.3760629
            const upperTick = 50200 // 151.3733069

            // alice adds liquidity (quote only) under the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("10"),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", await collateral.decimals()))
            await deposit(bob, vault, 100, collateral)

            // bob takes position
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("0.1"), // the amount of quote
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob close position
            await clearingHouse
                .connect(bob)
                .closePosition(
                    baseToken.address,
                    encodePriceSqrt("155", "1"),
                    ethers.constants.MaxUint256,
                    ethers.constants.HashZero,
                )

            // alice removes liquidity
            const { liquidity } = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const { available: aliceQuoteAvailableAfter } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            // alice got extra quote from fee
            expect(aliceQuoteAvailableAfter.gt(parseEther("0"))).to.be.true

            // TODO: move to closePosition's tests
            // await expect(clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter))
            //     .to.emit(clearingHouse, "Burned")
            //     .withArgs(alice.address, quoteToken.address, parseEther("10"))

            // expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
            //     parseEther("0"), // available
            //     parseEther("0"), // debt
            // ])

            // const profit = aliceQuoteAvailableAfter.sub(aliceQuoteAvailableBefore)
            // expect(await vault.getFreeCollateral(alice.address)).to.eq(parseEther("10").add(profit))
        })

        it("# burn quote 10 when debt = 10, available < 10", async () => {
            // P(50400) = 1.0001^50400 ~= 151.4310961
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await exchange.addPool(baseToken.address, 10000)

            const lowerTick = 50200 // 151.3733069
            const upperTick = 50400 // 154.4310961

            const { debt: aliceQuoteDebt } = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)

            // alice adds liquidity (quote only) under the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("10"),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", await collateral.decimals()))
            await deposit(bob, vault, 100, collateral)

            await clearingHouse.connect(bob).openPosition({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.001"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            const { liquidity } = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const { available: aliceQuoteAvailableAfterSwap } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            // alice's quote got swapped
            expect(aliceQuoteAvailableAfterSwap.lt(parseEther("10"))).to.be.true
        })
    })

    describe("burn base when debt = 10", () => {
        beforeEach(async () => {
            // P(50000) = 1.0001^50000 ~= 148.3760629
            await pool.initialize(encodePriceSqrt("148.3760629", "1"))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await exchange.addPool(baseToken.address, 10000)

            // prepare collateral for alice
            await collateral.mint(alice.address, parseUnits("1000", await collateral.decimals()))
            await collateral.connect(alice).approve(clearingHouse.address, parseEther("1000"))
            await deposit(alice, vault, 1000, collateral)

            // TODO: the index price of base is hardcoded as $100
        })

        it("# burn base 10 when debt = 10, available < 10", async () => {
            const lowerTick = 50200 // 151.3733069
            const upperTick = 50400 // 154.4310961

            const { debt: aliceBaseDebt } = await clearingHouse.getTokenInfo(alice.address, baseToken.address)

            // alice adds liquidity (base only) above the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("10"),
                quote: parseEther("0"),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", await collateral.decimals()))
            await deposit(bob, vault, 100, collateral)

            // bob swaps quote for base (buy base), so alice receives quote as fee and has less base
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("0.01"), // the amount of base to buy
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            const { liquidity } = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const { available: aliceBaseAvailableAfterSwap } = await clearingHouse.getTokenInfo(
                alice.address,
                baseToken.address,
            )

            // alice's base got swapped
            expect(aliceBaseAvailableAfterSwap.lt(parseEther("10"))).to.be.true
        })

        it("maker takers other side of exposure after taker trade", async () => {
            const lowerTick = 50000 // 148.3760629
            const upperTick = 50200 // 151.3733069

            // alice adds liquidity (base only) above the current price
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("10"),
                quote: parseEther("0"),
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", await collateral.decimals()))
            await deposit(bob, vault, 100, collateral)

            // bob swaps quote to base (buy base), so alice receives quote as fee
            // 0.1 base leaves the pool
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("0.1"), // the amount of base
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // alice removes liquidity
            const { liquidity } = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // there's imprecision
            expect(await clearingHouse.getPositionSize(alice.address, baseToken.address)).to.eq(
                parseEther("-0.100000000000000001"),
            )
            expect(await clearingHouse.getPositionSize(bob.address, baseToken.address)).to.eq(parseEther("0.1"))
        })
    })
})
