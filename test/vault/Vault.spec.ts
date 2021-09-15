import { MockContract, smockit } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { InsuranceFund, TestERC20, Vault } from "../../typechain"
import { mockedVaultFixture } from "./fixtures"

describe.only("Vault spec", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let clearingHouse: MockContract
    let insuranceFund: MockContract

    beforeEach(async () => {
        const _fixture = await loadFixture(mockedVaultFixture)
        vault = _fixture.vault
        usdc = _fixture.USDC
        clearingHouse = _fixture.mockedClearingHouse
        insuranceFund = _fixture.mockedInsuranceFund

        // mint
        const amount = parseUnits("1000", await usdc.decimals())
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        await usdc.mint(admin.address, amount)
    })

    describe("# initialize", () => {
        it("force error, invalid clearingHouse address", async () => {
            const vaultFactory = await ethers.getContractFactory("Vault")
            const vault = (await vaultFactory.deploy()) as Vault
            await expect(vault.initialize(alice.address)).to.be.revertedWith("V_ANC")
        })
    })

    describe("decimals", () => {
        it("equals to settlement token's decimal")
    })

    describe("set clearingHouse", () => {
        it("correctly set clearingHouse", async () => {
            // set to another contract address
            await vault.setClearingHouse(insuranceFund.address)
        })

        it("force error, not a contract address", async () => {
            await expect(vault.setClearingHouse(admin.address)).to.be.revertedWith("V_ANC")
        })
    })

    describe("set insurance fund", () => {
        let mockedInsuranceFund: MockContract
        beforeEach(async () => {
            const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
            const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
            mockedInsuranceFund = await smockit(insuranceFund)
            mockedInsuranceFund.smocked.token.will.return.with(usdc.address)
        })

        it("correctly set insurance fund", async () => {
            // set to another contract address
            await vault.setInsuranceFund(mockedInsuranceFund.address)
        })

        it("force error, not a contract address", async () => {
            await expect(vault.setInsuranceFund(admin.address)).to.be.revertedWith("V_IFNC")
        })

        it("force error, settlement token not match", async () => {
            mockedInsuranceFund.smocked.token.will.return.with(admin.address)
            await expect(vault.setInsuranceFund(mockedInsuranceFund.address)).to.be.revertedWith("V_STNM")
        })
    })

    describe("admin only simple setter", () => {
        it("setClearingHouse")
        it("setCloseFactor")
        it("setLiquidationIncentive")
        it("setLiquidationOrder")
        it("force error by non-admin")
        it("force error, invalid ClearingHouse address", async () => {
            await expect(vault.setClearingHouse(alice.address)).to.be.revertedWith("V_ANC")
        })

        it("force error, invalid TrustedForwarder address", async () => {
            await expect(vault.setTrustedForwarder(alice.address)).to.be.revertedWith("V_ANC")
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
            expect(await vault.balanceOf(alice.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it.skip("non-standard ERC20 (USDT) is supported")

        it("can't add collateral not supported")
    })

    describe("getFreeCollateral", () => {
        it("equals to total collateral value + locked collateral value (0)")
        it("equals to total collateral value + locked collateral value ( > 0)")
        it("force error, clearingHouse not found")
    })

    describe("withdraw settlement token", async () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            amount = parseUnits("100", await usdc.decimals())
            await vault.connect(alice).deposit(usdc.address, amount)

            clearingHouse.smocked.settle.will.return.with(0)
            clearingHouse.smocked.getOwedRealizedPnl.will.return.with(0)
            clearingHouse.smocked.getAccountValue.will.return.with(amount)
            clearingHouse.smocked.getTotalInitialMarginRequirement.will.return.with(0)
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
            expect(await vault.balanceOf(alice.address)).to.eq("0")
        })

        it("force error if the freeCollateral is not enough", async () => {
            // account value decreased, so free collateral is not enough
            clearingHouse.smocked.getAccountValue.will.return.with(amount.div(2))

            await expect(vault.connect(alice).withdraw(usdc.address, amount)).to.be.revertedWith("V_NEFC")
        })
    })

    describe.skip("withdraw non-settlement token", () => {
        it("reduce vault's token balance")
        it("increase sender's token balance")
        it("force error if the freeCollateral is not enough")
    })

    // TODO not sure if this is needed
    describe("balanceOf", () => {
        it("is zero by default", async () => {
            expect(await vault.balanceOf(alice.address)).eq(0)
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
})
