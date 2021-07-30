import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse withdraw", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await clearingHouse.addPool(baseToken.address, 10000)
    })

    describe("# withdraw with maker fee", () => {
        const lowerTick = 50000 // 148.3760629
        const upperTick = 50200 // 151.3733069

        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            // mint
            collateral.mint(alice.address, toWei(100))

            // prepare collateral for alice
            await deposit(alice, vault, 100, collateral)

            // mint vToken
            const quoteAmount = parseEther("0.122414646")
            await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: 0,
                quote: quoteAmount,
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
            }
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)
        })

        it("taker swap then withdraw and verify maker's free collateral", async () => {
            // prepare collateral for bob
            await collateral.mint(bob.address, parseEther("100"))
            await deposit(bob, vault, 100, collateral)
            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("1"))

            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334176 quote
            // bob gets 0.06151334176 * 0.99 = 0.06089820834
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // accountValue = netQuoteBalance + totalMarketPnl = 100 + 0.06 + 0
            // pnl is 0 because it's calculated based on index price
            // min(100, 100+) - (0 + 1 * 100) * 10% = 99.8993848666
            expect(await vault.getFreeCollateral(bob.address)).to.eq(parseEther("90"))
            await expect(vault.connect(bob).withdraw(collateral.address, parseEther("90")))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, parseEther("90"))
            expect(await collateral.balanceOf(bob.address)).to.eq(parseEther("90"))
            expect(await vault.balanceOf(bob.address)).to.eq(parseEther("10"))

            // alice remove liq 0, alice should collect fee
            // B2QFee: expect 1% of quote = 0.0006151334176 ~= 615133417572501 / 10^18
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
            })

            // verify maker's free collateral
            // collateral = 100, base debt = 0, quote debt = 0.122414646
            // maker.quoteInPool -= 0.06151334176
            // maker.baseInPool += 0.0004084104205
            // free collateral =
            // min(100, 100 - 0.06151334176 (+Q) + 0.0006151334176 (B2QFee) + 0.0004084104205 (-B) * 100 (indexPrice)) - (0 + 0.122414646) * 0.1 = 10,000
            // 100 - 0.06151334176 + 0.0006151334176 + 0.0004084104205 * 100 - (0 + 0.122414646) * 0.1 = 99.9677013691
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseEther("99.967701369110322151"))
        })
    })

    describe("# withdraw", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, toWei(20000, await collateral.decimals()))
            await deposit(alice, vault, 20000, collateral)
            const collateralAmount = toWei(1000, await collateral.decimals())
            await collateral.mint(bob.address, collateralAmount)
            await deposit(bob, vault, 1000, collateral)

            // alice as maker add liq. first
            await pool.initialize(encodePriceSqrt("151.373306", "1"))
            await clearingHouse.connect(alice).mint(baseToken.address, toWei(500))
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(50000))
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(500),
                quote: toWei(50000),
                lowerTick: 50000,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("taker do nothing and then withdraw", async () => {
            const amount = toWei(1000, await collateral.decimals())
            expect(await vault.getFreeCollateral(bob.address)).to.eq(amount)

            await expect(vault.connect(bob).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, amount)
            expect(await collateral.balanceOf(bob.address)).to.eq(amount)
            expect(await vault.balanceOf(bob.address)).to.eq("0")
        })

        it("maker withdraw after adding liquidity", async () => {
            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(20000, 20000) - (500 * 100 + 50000, 0) * 10% = 10000
            const amount = toWei(10000, await collateral.decimals())
            expect(await vault.getFreeCollateral(alice.address)).to.eq(amount)

            await expect(vault.connect(alice).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, amount)
            expect(await collateral.balanceOf(alice.address)).to.eq(amount)
            expect(await vault.balanceOf(alice.address)).to.eq(amount)
        })

        it("force error, withdraw without deposit", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEB")
        })

        it("force error, margin requirement is larger than accountValue", async () => {
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(10000))
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(10000),
                sqrtPriceLimitX96: 0,
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(1000, accountValue) < (0 + 10,000) * 10% = 1000
            // accountValue = 1000 + PnL, PnL is negative due to fee
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than collateral", async () => {
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(100))
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(100),
                sqrtPriceLimitX96: 0,
            })

            // carol open a short position to make price goes down.
            // So that Bob has profit
            const collateralAmount = toWei(1000, await collateral.decimals())
            await collateral.mint(carol.address, collateralAmount)
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).mint(baseToken.address, toWei(10))
            await clearingHouse.connect(carol).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(1),
                sqrtPriceLimitX96: 0,
            })

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("110", 6), 0, 0, 0]
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(1000, 1000 + profit) < (0 + 100 * 110) * 10% = 1100
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, withdrawal amount is more than collateral", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, toWei(5000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEB")
        })
    })
})
