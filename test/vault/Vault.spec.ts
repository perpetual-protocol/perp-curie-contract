import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, Vault } from "../../typechain"
import { mockedVaultFixture } from "./fixtures"

describe("Vault spec", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let insuranceFund: MockContract
    let accountBalance: MockContract
    let clearingHouseConfig: MockContract

    beforeEach(async () => {
        const _fixture = await loadFixture(mockedVaultFixture)
        vault = _fixture.vault
        usdc = _fixture.USDC
        insuranceFund = _fixture.mockedInsuranceFund
        accountBalance = _fixture.mockedAccountBalance
        clearingHouseConfig = _fixture.mockedClearingHouseConfig

        // mint
        const amount = parseUnits("1000", await usdc.decimals())
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        await usdc.mint(admin.address, amount)
    })

    describe("# initialize", () => {
        it("force error, invalid insurance fund address", async () => {
            const vaultFactory = await ethers.getContractFactory("Vault")
            const vault = (await vaultFactory.deploy()) as Vault
            await expect(
                vault.initialize(alice.address, alice.address, alice.address, alice.address),
            ).to.be.revertedWith("function call to a non-contract account")
        })
    })

    describe("decimals", () => {
        it("equals to settlement token's decimal")
    })

    describe("admin only simple setter", () => {
        it("setClearingHouse")
        it("setCloseFactor")
        it("setLiquidationIncentive")
        it("setLiquidationOrder")
        it("force error by non-admin")

        it("force error, invalid TrustedForwarder address", async () => {
            await expect(vault.setTrustedForwarder(alice.address)).to.be.revertedWith("V_TFNC")
        })
    })

    describe.skip("setLiquidationOrder", () => {
        it("updated liquidationOrder")
        it("force error, the numbers of asset did not match")
        it("force error by non-admin")
    })

    describe.skip("addCollateral", () => {
        it("add an ERC20 with totalWeight, initWeight and IMF-Factor")
        it("force error, none of the input can be 0")
        it("can't add native ETH")
        it("can't add existed collateral")
        it("force error, ERC20 without decimals")
        it("force error by non-admin")
    })

    describe.skip("isCollateral", () => {})

    describe("deposit", () => {
        beforeEach(async () => {
            clearingHouseConfig.smocked.getSettlementTokenBalanceCap.will.return.with(
                async () => ethers.constants.MaxUint256,
            )
        })

        // @SAMPLE - deposit
        it("sends event", async () => {
            const amount = parseUnits("100", await usdc.decimals())

            // check event has been sent
            await expect(vault.connect(alice).deposit(usdc.address, amount))
                .to.emit(vault, "Deposited")
                .withArgs(usdc.address, alice.address, amount)

            // reduce alice balance
            expect(await usdc.balanceOf(alice.address)).to.eq(parseUnits("900", await usdc.decimals()))

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(parseUnits("100", await usdc.decimals()))

            // update sender's balance
            expect(await vault.getBalance(alice.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it("force error, inconsistent vault balance with deflationary token", async () => {
            usdc.setTransferFeeRatio(50)
            await expect(
                vault.connect(alice).deposit(usdc.address, parseUnits("100", await usdc.decimals())),
            ).to.be.revertedWith("V_IBA")
            usdc.setTransferFeeRatio(0)
        })

        it("can't add collateral not supported")
    })

    describe("depositFor", async () => {
        beforeEach(async () => {
            clearingHouseConfig.smocked.getSettlementTokenBalanceCap.will.return.with(
                async () => ethers.constants.MaxUint256,
            )
        })

        it("should be able to deposit for others", async () => {
            const amount = parseUnits("100", await usdc.decimals())
            await vault.connect(alice).depositFor(bob.address, usdc.address, amount)

            const bobBalance = await vault.getBalance(bob.address)
            const aliceBalance = await vault.getBalance(alice.address)
            const aliceUsdcBalanceAfter = await usdc.balanceOf(alice.address)

            // reduce alice's usdc balance
            expect(aliceUsdcBalanceAfter).to.be.eq(parseUnits("900", await usdc.decimals()))

            // bob's usdc balance not changed
            expect(await usdc.balanceOf(bob.address)).to.be.eq("0")

            // alice's vault balance not changed
            expect(aliceBalance).to.be.eq(parseUnits("0", await usdc.decimals()))

            // increase bob's vault balance
            expect(bobBalance).to.be.eq(amount)

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it("should be able to deposit for alice herself", async () => {
            const amount = parseUnits("100", await usdc.decimals())
            await vault.connect(alice).depositFor(alice.address, usdc.address, amount)

            const aliceBalance = await vault.getBalance(alice.address)
            const aliceUsdcBalanceAfter = await usdc.balanceOf(alice.address)

            // reduce alice's usdc balance
            expect(aliceUsdcBalanceAfter).to.be.eq(parseUnits("900", await usdc.decimals()))

            // increase alice's vault balance
            expect(aliceBalance).to.be.eq(amount)

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it("force error when depositor do not have enough money", async () => {
            const amount = parseUnits("1100", await usdc.decimals())
            await expect(vault.connect(alice).depositFor(bob.address, usdc.address, amount)).to.be.revertedWith(
                "revert ERC20: transfer amount exceeds balance",
            )
        })

        it("force error when deposit for zero address", async () => {
            const amount = parseUnits("1000", await usdc.decimals())
            await expect(
                vault.connect(alice).depositFor(ethers.constants.AddressZero, usdc.address, amount),
            ).to.be.revertedWith("V_DFZA")
        })
    })

    describe("getFreeCollateral", () => {
        it("equals to total collateral value + locked collateral value (0)")
        it("equals to total collateral value + locked collateral value ( > 0)")
        it("force error, clearingHouse not found")
    })

    describe("withdraw settlement token", async () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            clearingHouseConfig.smocked.getSettlementTokenBalanceCap.will.return.with(
                async () => ethers.constants.MaxUint256,
            )

            amount = parseUnits("100", await usdc.decimals())
            await vault.connect(alice).deposit(usdc.address, amount)

            accountBalance.smocked.settleOwedRealizedPnl.will.return.with(0)
            accountBalance.smocked.getPnlAndPendingFee.will.return.with([0, amount, 0])
            accountBalance.smocked.getTotalDebtValue.will.return.with(0)
        })

        it("emit event and update balances", async () => {
            const balanceBefore = await usdc.balanceOf(alice.address)

            await expect(vault.connect(alice).withdraw(usdc.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, amount)

            // decrease vault's token balance
            expect(await usdc.balanceOf(vault.address)).to.eq("0")

            const balanceAfter = await usdc.balanceOf(alice.address)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.eq("0")
        })

        it("force error if the freeCollateral is not enough", async () => {
            // unrealizedPnl = -amount, so free collateral is not enough
            accountBalance.smocked.getPnlAndPendingFee.will.return.with([0, parseEther("-100"), 0])

            await expect(vault.connect(alice).withdraw(usdc.address, amount)).to.be.revertedWith("V_NEFC")
        })
    })

    describe.skip("withdraw non-settlement token", () => {
        it("reduce vault's token balance")
        it("increase sender's token balance")
        it("force error if the freeCollateral is not enough")
    })

    // TODO not sure if this is needed
    describe("getBalance", () => {
        it("is zero by default", async () => {
            expect(await vault.getBalance(alice.address)).eq(0)
        })

        it("equals to USDC balance if it's the only collateral")
        it("equals multi collateral's USDC value")
    })

    describe.skip("liquidate", () => {
        it("force error, close more than maxCloseFactor")
        it("force error, close less than minCloseFactor")
        it("force error, liquidator can't be the same as the position owner")
        describe("no bad debt", () => {
            it("reduce USDC balance")
            it("increase liquidation asset, WETH")
            it("get cheaper WETH compare to UniswapV3 TWAP")
        })

        describe("has bad debt", () => {
            it("reduce USDC balance")
            it("increase liquidation asset, WETH")
            it("get cheaper WETH compare to UniswapV3 TWAP")
            it("reduce usdcDebt if usdc debt > bad debt")
            it("reduce usdcDebt to 0 if usdc debt <= bad debt, insurance fund cover extra bad debt")
            it("insurance fund cover full bad debt when usdcDebt is 0")
        })
    })

    describe("settlementTokenBalanceCap > 0", () => {
        beforeEach(async () => {
            clearingHouseConfig.smocked.getSettlementTokenBalanceCap.will.return.with(async () => 100)
        })

        it("force error when it's over settlementTokenBalanceCap", async () => {
            await expect(vault.connect(alice).deposit(usdc.address, 101)).to.be.revertedWith("V_GTSTBC")
        })

        it("force error when the the total balance is over cap", async () => {
            await expect(vault.connect(alice).deposit(usdc.address, 100)).not.be.reverted
            await expect(vault.connect(alice).deposit(usdc.address, 1)).to.be.revertedWith("V_GTSTBC")
        })

        it("can deposit if balanceOf(vault) <= settlementTokenBalanceCap after deposited", async () => {
            await expect(vault.connect(alice).deposit(usdc.address, 99)).not.be.reverted
        })

        it("cannot deposit when settlementTokenBalanceCap == 0", async () => {
            clearingHouseConfig.smocked.getSettlementTokenBalanceCap.will.return.with(async () => 0)
            await expect(vault.connect(alice).deposit(usdc.address, 101)).to.be.revertedWith("V_GTSTBC")
        })
    })
})
