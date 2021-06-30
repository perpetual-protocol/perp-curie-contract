pragma solidity 0.7.6;

import "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";

// TODO: Ownable
// TODO: only keep what we need in ERC20PresetMinterPauser
contract BaseToken is ERC20PresetMinterPauser {
    using SafeMath for uint256;
    address public immutable priceFeed;
    uint8 private immutable _priceFeedDecimals;

    constructor(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) ERC20PresetMinterPauser(nameArg, symbolArg) {
        // BT_IA: invalid address
        require(priceFeedArg != address(0), "BT_IA");

        priceFeed = priceFeedArg;
        _priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
    }

    // TODO: onlyOwner
    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function getIndexPrice(uint256 interval) external view returns (uint256) {
        return _formatDecimals(IPriceFeed(priceFeed).getPrice(interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
