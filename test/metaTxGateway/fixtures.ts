import { ethers } from "hardhat"
import { MetaTxGateway, TestMetaTxRecipient } from "../../typechain"

interface MetaTxGatewayFixture {
    metaTxGateway: MetaTxGateway
    metaTxRecipient: TestMetaTxRecipient
}

export function createMetaTxGatewayFixture(): () => Promise<MetaTxGatewayFixture> {
    return async (): Promise<MetaTxGatewayFixture> => {
        // deploy meta tx gateway
        const metaTxGatewayFactory = await ethers.getContractFactory("MetaTxGateway")
        const metaTxGateway = (await metaTxGatewayFactory.deploy("Test", "1", 1)) as MetaTxGateway

        const metaTxGatewayRecipientFactory = await ethers.getContractFactory("TestMetaTxRecipient")
        const metaTxRecipient = (await metaTxGatewayRecipientFactory.deploy(
            metaTxGateway.address,
        )) as TestMetaTxRecipient

        return { metaTxGateway, metaTxRecipient }
    }
}
