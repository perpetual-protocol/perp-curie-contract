import { ethers } from "hardhat"

async function main() {
    // We get the contract to deploy
    const TestUSDC = await ethers.getContractFactory("TestERC20")
    const testUsdc = await TestUSDC.deploy("TestUSDC", "TestUSDC")

    console.log("TestUSDC deployed to:", testUsdc.address)

    // testnet deployer
    await testUsdc.setMinter("0x9e9dfaccabeecda6dd913b3685c9fe908f28f58c")
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
